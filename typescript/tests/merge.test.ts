/**
 * Tests for the merge orchestrator (#567).
 *
 * The bug being fixed is that every strategy behaved like `describe`, so the
 * tests that matter most are the ones proving the three strategies now differ,
 * and that a failed push restores what the watch had rather than leaving the
 * activity stripped of both its own sets and ours.
 */
import { describe, it, expect, vi } from "vitest";
import {
  mergeIntoWatchActivity,
  isWatchRecorded,
  isWatchStrategy,
  DEFAULT_WATCH_STRATEGY,
} from "../src/sync/merge";
import type { GarminGateway } from "../src/sync/gateway";

const WORKOUT = {
  start_time: "2026-09-15T10:00:00Z",
  end_time: "2026-09-15T11:00:00Z",
  exercises: [
    { title: "Bench Press (Barbell)", sets: [{ reps: 10, weight_kg: 60 }, { reps: 8, weight_kg: 70 }] },
  ],
};
const NOW = new Date("2026-09-15T12:00:00Z");

const WATCH_ACTIVITY = {
  activityId: 777,
  duration: 3600,
  startTimeGMT: "2026-09-15 10:02:00",
  activityType: { typeKey: "strength_training" },
  manufacturer: "GARMIN",
};

function gw(over: Partial<GarminGateway> = {}, activities = [WATCH_ACTIVITY]): GarminGateway {
  return {
    findExistingActivity: vi.fn(async () => null),
    upload: vi.fn(async () => ({ uploadId: null, activityId: null })),
    rename: vi.fn(async () => {}),
    describe: vi.fn(async () => {}),
    activitiesByDate: vi.fn(async () => activities as never),
    exerciseSets: vi.fn(async () => ({ exerciseSets: [{ old: true }] })),
    putExerciseSets: vi.fn(async () => {}),
    ...over,
  } as GarminGateway;
}

describe("mergeIntoWatchActivity", () => {
  it("pushes the sets for the merge strategy, which is what never happened before", async () => {
    const g = gw();
    const r = await mergeIntoWatchActivity(g, WORKOUT, { strategy: "merge", now: NOW });
    expect(r.merged).toBe(true);
    expect(r.activityId).toBe(777);
    expect(r.setsPushed).toBe(2);
    expect(g.putExerciseSets).toHaveBeenCalledTimes(1);
    const [id, payload] = (g.putExerciseSets as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(id).toBe(777);
    expect((payload as { exerciseSets: unknown[] }).exerciseSets.length).toBeGreaterThan(0);
  });

  it("pushes nothing for describe, which is the behaviour merge was wrongly giving", async () => {
    const g = gw();
    const r = await mergeIntoWatchActivity(g, WORKOUT, { strategy: "describe", now: NOW });
    expect(r.merged).toBe(true);
    expect(r.setsPushed).toBe(0);
    expect(g.putExerciseSets).not.toHaveBeenCalled();
  });

  it("asks the caller to replace rather than uploading or deleting itself", async () => {
    const g = gw();
    const r = await mergeIntoWatchActivity(g, WORKOUT, { strategy: "replace", now: NOW });
    expect(r.merged).toBe(false);
    expect(r.replaceWatchActivity).toBe(true);
    expect(r.activityId).toBe(777);
    expect(g.putExerciseSets).not.toHaveBeenCalled();
    expect(g.upload).not.toHaveBeenCalled();
  });

  it("backs the old sets up first, and restores them when the push fails", async () => {
    const put = vi.fn(async (_id: number, payload: unknown) => {
      // Fail every attempt to write OUR payload; accept the restore.
      if ((payload as { exerciseSets?: unknown[] }).exerciseSets?.length !== 1) {
        throw new Error("500 Server Error");
      }
    });
    const g = gw({ putExerciseSets: put as never });
    const r = await mergeIntoWatchActivity(g, WORKOUT, { strategy: "merge", now: NOW });
    expect(r.merged).toBe(false);
    expect(r.reason).toContain("exerciseSets push failed");
    expect(g.exerciseSets).toHaveBeenCalledWith(777);
    // The last write put the backup back.
    const calls = put.mock.calls;
    expect(calls[calls.length - 1][1]).toEqual({ exerciseSets: [{ old: true }] });
  });

  it("merges into an activity we uploaded ourselves, and verifies the names stuck", async () => {
    // It used to refuse outright, which is why re-syncing an edited workout
    // updated the title and left the sets alone (#597). It now pushes and then
    // reads back; this fake returns no sets, which reads as "Garmin dropped
    // them", so the merge is undone and a named upload is requested instead.
    const own = { ...WATCH_ACTIVITY, manufacturer: "DEVELOPMENT" };
    const g = gw({}, [own]);
    const r = await mergeIntoWatchActivity(g, WORKOUT, {
      strategy: "merge",
      now: NOW,
      verifyDelayMs: 0,
    });
    expect(g.putExerciseSets).toHaveBeenCalled();
    expect(r.forceFreshUpload).toBe(true);
  });

  it("reports no match rather than merging into the wrong activity", async () => {
    const g = gw({}, []);
    const r = await mergeIntoWatchActivity(g, WORKOUT, { strategy: "merge", now: NOW });
    expect(r.merged).toBe(false);
    expect(r.reason).toBe("no matching Garmin activity found");
  });

  it("distinguishes a Garmin outage from a clean no-match", async () => {
    const g = gw({ activitiesByDate: vi.fn(async () => { throw new Error("503"); }) as never });
    const r = await mergeIntoWatchActivity(g, WORKOUT, { strategy: "merge", now: NOW });
    expect(r.merged).toBe(false);
    expect(r.reason).toContain("could not list Garmin activities");
  });

  it("honours the activity-type filter, so a climbing session is left alone", async () => {
    const climb = { ...WATCH_ACTIVITY, activityType: { typeKey: "indoor_climbing" } };
    const g = gw({}, [climb]);
    const off = await mergeIntoWatchActivity(g, WORKOUT, { strategy: "merge", now: NOW });
    expect(off.merged).toBe(false);
    const on = await mergeIntoWatchActivity(g, WORKOUT, {
      strategy: "merge", now: NOW, activityTypes: ["strength_training", "indoor_climbing"],
    });
    expect(on.merged).toBe(true);
  });

  it("refuses a workout with no sets instead of wiping the activity's own", async () => {
    const g = gw();
    const r = await mergeIntoWatchActivity(g, { ...WORKOUT, exercises: [] }, { strategy: "merge", now: NOW });
    expect(r.merged).toBe(false);
    expect(r.reason).toContain("no sets to push");
    expect(g.putExerciseSets).not.toHaveBeenCalled();
  });

  it("defaults to merge, the documented default", async () => {
    expect(DEFAULT_WATCH_STRATEGY).toBe("merge");
    const g = gw();
    const r = await mergeIntoWatchActivity(g, WORKOUT, { now: NOW });
    expect(r.strategy).toBe("merge");
    expect(g.putExerciseSets).toHaveBeenCalled();
  });

  // The watch recorded two ACTIVE sets with its own timing; WORKOUT also has two.
  const WATCH_SETS = {
    exerciseSets: [
      { setType: "ACTIVE", duration: 22, startTime: "2026-09-15T10:02:00.0", messageIndex: 0, wktStepIndex: 0, exercises: [{ category: "UNKNOWN", name: null, probability: 0 }] },
      { setType: "REST", duration: 55, startTime: "2026-09-15T10:02:40.0", messageIndex: 1, exercises: [] },
      { setType: "ACTIVE", duration: 31, startTime: "2026-09-15T10:03:40.0", messageIndex: 2, wktStepIndex: 0, exercises: [{ category: "UNKNOWN", name: null, probability: 0 }] },
    ],
  };

  it("keeps the watch's own set timing by default (#748)", async () => {
    const g = gw({ exerciseSets: vi.fn(async () => WATCH_SETS) as never });
    const r = await mergeIntoWatchActivity(g, WORKOUT, { strategy: "merge", now: NOW });
    expect(r.merged).toBe(true);
    const [, payload] = (g.putExerciseSets as ReturnType<typeof vi.fn>).mock.calls[0];
    const active = (payload as { exerciseSets: Array<Record<string, unknown>> }).exerciseSets.filter(
      (s) => s.setType === "ACTIVE",
    );
    expect(active.map((s) => s.duration)).toEqual([22, 31]); // the watch's, not synthesized
    expect((active[0].exercises as Array<Record<string, unknown>>)[0].category).toBe("BENCH_PRESS");
  });

  it("uses the synthesized timing when preserveWatchTiming is off", async () => {
    const g = gw({ exerciseSets: vi.fn(async () => WATCH_SETS) as never });
    const r = await mergeIntoWatchActivity(g, WORKOUT, {
      strategy: "merge",
      preserveWatchTiming: false,
      now: NOW,
    });
    expect(r.merged).toBe(true);
    const [, payload] = (g.putExerciseSets as ReturnType<typeof vi.fn>).mock.calls[0];
    const active = (payload as { exerciseSets: Array<Record<string, unknown>> }).exerciseSets.filter(
      (s) => s.setType === "ACTIVE",
    );
    expect(active.map((s) => s.duration)).not.toEqual([22, 31]);
  });
});

describe("helpers", () => {
  it("treats DEVELOPMENT and a blank manufacturer as not a watch", () => {
    expect(isWatchRecorded({ manufacturer: "GARMIN" })).toBe(true);
    expect(isWatchRecorded({ manufacturer: "development" })).toBe(false);
    expect(isWatchRecorded({ manufacturer: "" })).toBe(false);
    expect(isWatchRecorded({})).toBe(false);
  });

  it("validates a strategy from settings, which arrives as an untrusted string", () => {
    expect(isWatchStrategy("merge")).toBe(true);
    expect(isWatchStrategy("replace")).toBe(true);
    expect(isWatchStrategy("describe")).toBe(true);
    expect(isWatchStrategy("nonsense")).toBe(false);
    expect(isWatchStrategy(undefined)).toBe(false);
  });
});
