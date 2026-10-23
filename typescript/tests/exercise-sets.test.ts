/**
 * Tests for the exerciseSets payload and the atomic-rejection retry (#567).
 *
 * The retry matters more than it looks. Garmin's PUT is atomic and names no
 * offender, so ONE exercise it dislikes 400s the whole payload and the user
 * loses every set. The bisection keeps every other name. Each branch of it is
 * covered here, including the case where several offenders are split across
 * halves and it has to give up on names entirely.
 */
import { describe, it, expect } from "vitest";
import {
  applyExistingTiming,
  buildExerciseSetsPayload,
  categoryToString,
  isSubcategoryRejection,
  namedExerciseKeys,
  stripExerciseNames,
  stripNamesFor,
  pushWithNameFallback,
  type ExerciseSetsPayload,
} from "../src/exercise-sets";

const START = "2026-09-15 10:00:00";

function workout(exercises: unknown[]) {
  return { exercises } as { exercises: never[] };
}

const BENCH = {
  title: "Bench Press (Barbell)",
  sets: [
    { type: "normal", reps: 10, weight_kg: 60 },
    { type: "normal", reps: 8, weight_kg: 70 },
  ],
};

describe("buildExerciseSetsPayload", () => {
  it("writes the reps and weights that the web path never sent at all", () => {
    const p = buildExerciseSetsPayload(workout([BENCH]), 42, START, 600);
    const active = p.exerciseSets.filter((s) => s.setType === "ACTIVE");
    expect(p.activityId).toBe(42);
    expect(active).toHaveLength(2);
    expect(active[0].repetitionCount).toBe(10);
    expect(active[1].repetitionCount).toBe(8);
    // Garmin takes weight in grams.
    expect(active[0].weight).toBe(60000);
    expect(active[1].weight).toBe(70000);
  });

  it("sends probability 100, because 0 renders the exercise as Unknown (#325)", () => {
    const p = buildExerciseSetsPayload(workout([BENCH]), 1, START, 600);
    for (const s of p.exerciseSets.filter((x) => x.setType === "ACTIVE")) {
      expect(s.exercises[0].probability).toBe(100);
    }
  });

  it("sends a null name rather than a guess when the exercise does not resolve", () => {
    // An invented name maps to nothing, so the category falls back to TOTAL_BODY
    // and the NAME must be null: an unrecognised name renders as "Unknown" (#138).
    const odd = { title: "Completely Invented Movement", sets: [{ reps: 5, weight_kg: 20 }] };
    const p = buildExerciseSetsPayload(workout([odd]), 1, START, 300);
    const ex = p.exerciseSets[0].exercises[0];
    expect(ex.category).toBe("TOTAL_BODY");
    expect(ex.name).toBeNull();
  });

  it("puts a REST set between sets but not after the final one", () => {
    const p = buildExerciseSetsPayload(workout([BENCH]), 1, START, 600);
    expect(p.exerciseSets.map((s) => s.setType)).toEqual(["ACTIVE", "REST", "ACTIVE"]);
  });

  it("scales the timeline to the activity and clamps the ratio to 0.3..2.0", () => {
    // Two working sets: 40 + 75 + 40 = 155s ideal. A 10-hour activity would
    // scale by ~232x, which the clamp holds at 2.0.
    const p = buildExerciseSetsPayload(workout([BENCH]), 1, START, 36000);
    const first = p.exerciseSets[0];
    expect(first.duration).toBeCloseTo(80, 5); // 40s * 2.0
    // And a very short activity clamps the other way, at 0.3.
    const short = buildExerciseSetsPayload(workout([BENCH]), 1, START, 1);
    expect(short.exerciseSets[0].duration).toBeCloseTo(12, 5); // 40s * 0.3
  });

  it("starts the first set at the activity's own start time", () => {
    const p = buildExerciseSetsPayload(workout([BENCH]), 1, START, 600);
    expect(p.exerciseSets[0].startTime).toBe("2026-09-15T10:00:00.0");
  });

  it("honours an explicit set duration and the shorter warmup default", () => {
    const w = workout([{ title: "Bench Press (Barbell)", sets: [
      { type: "warmup", reps: 10, weight_kg: 20 },
      { type: "normal", reps: 5, weight_kg: 60, duration_seconds: 90 },
    ] }]);
    // Ideal = 25 + 75 + 90 = 190; pass that as the duration so scale is 1.0.
    const p = buildExerciseSetsPayload(w, 1, START, 190);
    const active = p.exerciseSets.filter((s) => s.setType === "ACTIVE");
    expect(active[0].duration).toBeCloseTo(25, 5);
    expect(active[1].duration).toBeCloseTo(90, 5);
  });

  it("returns an empty payload rather than throwing when there is nothing to send", () => {
    expect(buildExerciseSetsPayload(workout([]), 1, START, 600).exerciseSets).toEqual([]);
    expect(buildExerciseSetsPayload({}, 1, START, 600).exerciseSets).toEqual([]);
    expect(buildExerciseSetsPayload(workout([BENCH]), 1, "not a date", 600).exerciseSets).toEqual([]);
  });

  it("maps an unknown category id to UNKNOWN", () => {
    expect(categoryToString(0)).toBe("BENCH_PRESS");
    expect(categoryToString(99999)).toBe("UNKNOWN");
  });
});

describe("isSubcategoryRejection", () => {
  it("recognises Garmin's wording and nothing else", () => {
    expect(isSubcategoryRejection(new Error("400 Invalid Sub-Category"))).toBe(true);
    expect(isSubcategoryRejection(new Error("invalid subcategory for exercise"))).toBe(true);
    expect(isSubcategoryRejection(new Error("401 Unauthorized"))).toBe(false);
    expect(isSubcategoryRejection(new Error("ECONNREFUSED"))).toBe(false);
  });
});

describe("payload name stripping", () => {
  const payload: ExerciseSetsPayload = {
    activityId: 1,
    exerciseSets: [
      { exercises: [{ category: "CURL", name: "BARBELL_CURL", probability: 100 }], duration: 1, setType: "ACTIVE", startTime: "t", wktStepIndex: 0, messageIndex: 0 },
      { exercises: [], duration: 1, setType: "REST", startTime: "t", wktStepIndex: 0, messageIndex: 1 },
      { exercises: [{ category: "ROW", name: "BARBELL_ROW", probability: 100 }], duration: 1, setType: "ACTIVE", startTime: "t", wktStepIndex: 1, messageIndex: 2 },
    ],
  };

  it("lists distinct named exercises in first-seen order", () => {
    expect(namedExerciseKeys(payload)).toEqual(["CURL|BARBELL_CURL", "ROW|BARBELL_ROW"]);
  });

  it("strips every name but keeps every category and set", () => {
    const s = stripExerciseNames(payload);
    expect(s.exerciseSets).toHaveLength(3);
    expect(s.exerciseSets[0].exercises[0]).toEqual({ category: "CURL", name: null, probability: 100 });
    expect(s.exerciseSets[2].exercises[0].category).toBe("ROW");
  });

  it("strips only the named offender", () => {
    const s = stripNamesFor(payload, new Set(["ROW|BARBELL_ROW"]));
    expect(s.exerciseSets[0].exercises[0].name).toBe("BARBELL_CURL");
    expect(s.exerciseSets[2].exercises[0].name).toBeNull();
  });
});

describe("pushWithNameFallback", () => {
  function payloadWith(names: string[]): ExerciseSetsPayload {
    return {
      activityId: 1,
      exerciseSets: names.map((n, i) => ({
        exercises: [{ category: "CURL", name: n, probability: 100 }],
        duration: 1, setType: "ACTIVE" as const, startTime: "t", wktStepIndex: i, messageIndex: i,
      })),
    };
  }
  const namesIn = (p: ExerciseSetsPayload) => p.exerciseSets.map((s) => s.exercises[0].name);

  it("sends once when Garmin accepts it", async () => {
    const seen: ExerciseSetsPayload[] = [];
    await pushWithNameFallback(async (p) => { seen.push(p); }, payloadWith(["A", "B"]));
    expect(seen).toHaveLength(1);
    expect(namesIn(seen[0])).toEqual(["A", "B"]);
  });

  it("keeps every other name when one exercise is rejected", async () => {
    const p = payloadWith(["A", "B", "C", "D"]);
    let last: ExerciseSetsPayload | null = null;
    await pushWithNameFallback(async (sent) => {
      // Garmin rejects the whole payload whenever C still carries its name.
      if (namesIn(sent).includes("C")) throw new Error("400 Invalid Sub-Category");
      last = sent;
    }, p);
    expect(namesIn(last!)).toEqual(["A", "B", null, "D"]);
  });

  it("strips the only name when there is just one candidate", async () => {
    let last: ExerciseSetsPayload | null = null;
    await pushWithNameFallback(async (sent) => {
      if (namesIn(sent).includes("A")) throw new Error("invalid sub-category");
      last = sent;
    }, payloadWith(["A"]));
    expect(namesIn(last!)).toEqual([null]);
  });

  it("falls back to stripping every name when offenders are split across halves", async () => {
    // A and D are both bad, so no single half is clean and the bisection cannot
    // converge. Landing the sets matters more than keeping the names.
    let last: ExerciseSetsPayload | null = null;
    await pushWithNameFallback(async (sent) => {
      const n = namesIn(sent);
      if (n.includes("A") || n.includes("D")) throw new Error("400 Invalid Sub-Category");
      last = sent;
    }, payloadWith(["A", "B", "C", "D"]));
    expect(namesIn(last!)).toEqual([null, null, null, null]);
  });

  it("rethrows anything that is not a subcategory rejection, rather than losing the sets quietly", async () => {
    await expect(
      pushWithNameFallback(async () => { throw new Error("401 Unauthorized"); }, payloadWith(["A", "B"])),
    ).rejects.toThrow("401 Unauthorized");
  });

  it("rethrows a non-subcategory error raised during the bisection", async () => {
    let calls = 0;
    await expect(
      pushWithNameFallback(async () => {
        calls += 1;
        throw calls === 1 ? new Error("400 Invalid Sub-Category") : new Error("500 Server Error");
      }, payloadWith(["A", "B", "C", "D"])),
    ).rejects.toThrow("500 Server Error");
  });
});

describe("set timing comes from the user's settings", () => {
  const w = {
    exercises: [
      {
        title: "Bench Press (Barbell)",
        sets: [
          { reps: 10, weight_kg: 60, type: "warmup" },
          { reps: 8, weight_kg: 80 },
        ],
      },
      { title: "Bench Press (Barbell)", sets: [{ reps: 5, weight_kg: 90 }] },
    ],
  };
  const START = "2026-09-15T10:00:00Z";

  /** Durations in payload order, rounded, so a scale of 1 is readable. */
  function durations(timing?: Record<string, number>) {
    // A duration equal to the ideal total keeps the scale at 1, so the numbers
    // that come back are the ones that went in.
    const ideal = timing
      ? timing.warmupSetS + timing.restSetsS + timing.workingSetS + timing.restExercisesS + timing.workingSetS
      : 25 + 75 + 40 + 120 + 40;
    const p = buildExerciseSetsPayload(w as never, 1, START, ideal, undefined, timing);
    return p.exerciseSets.map((s) => Math.round(s.duration));
  }

  it("keeps the defaults for timing values passed as undefined (#703)", () => {
    // The web settings loader used to pass all four keys with undefined for the
    // ones never saved, which made every set time NaN and threw.
    const undef = { workingSetS: undefined, warmupSetS: undefined, restSetsS: undefined, restExercisesS: undefined };
    const p = buildExerciseSetsPayload(w as never, 1, START, 25 + 75 + 40 + 120 + 40, undefined, undef as never);
    expect(p.exerciseSets.map((s) => Math.round(s.duration))).toEqual([25, 75, 40, 120, 40]);
  });

  it("uses the documented defaults when the user changed nothing", () => {
    expect(durations()).toEqual([25, 75, 40, 120, 40]);
  });

  it("lays the sets out with the user's own times", () => {
    // Someone who rests three minutes between sets does not train like someone
    // who rests one, and the merged activity should say so.
    expect(
      durations({ warmupSetS: 30, workingSetS: 60, restSetsS: 180, restExercisesS: 240 }),
    ).toEqual([30, 180, 60, 240, 60]);
  });

  it("an explicit per-set duration from Hevy still wins over the setting", () => {
    const p = buildExerciseSetsPayload(
      { exercises: [{ title: "Plank", sets: [{ duration_seconds: 90 }] }] } as never,
      1,
      START,
      90,
      undefined,
      { workingSetS: 5 },
    );
    expect(Math.round(p.exerciseSets[0].duration)).toBe(90);
  });
});

// A watch's own exerciseSets read-back: a REST between each ACTIVE set, with
// deliberately distinct durations so a test can tell the watch's timing from the
// synthesized one that makes every set the same length (#748).
function watchRecording(activeDurations: number[], activityId = 42): Record<string, unknown> {
  const sets: Record<string, unknown>[] = [];
  let msg = 0;
  activeDurations.forEach((dur, i) => {
    sets.push({
      setType: "ACTIVE",
      duration: dur,
      startTime: `2026-09-15T10:0${i}:00.0`,
      messageIndex: msg++,
      wktStepIndex: 0,
      exercises: [{ category: "UNKNOWN", name: null, probability: 0 }],
    });
    if (i < activeDurations.length - 1) {
      sets.push({
        setType: "REST",
        duration: 50 + i,
        startTime: `2026-09-15T10:0${i}:40.0`,
        messageIndex: msg++,
        exercises: [],
      });
    }
  });
  return { activityId, exerciseSets: sets };
}

describe("applyExistingTiming", () => {
  // BENCH has 2 sets; this exercise list yields 3 ACTIVE sets total.
  const WORKOUT = { exercises: [BENCH, { title: "Squat (Barbell)", sets: [{ reps: 5, weight_kg: 100 }] }] } as never;
  const synth = () => buildExerciseSetsPayload(WORKOUT, 42, START, 600);

  it("keeps the watch's duration and startTime on every ACTIVE set", () => {
    const durations = [22, 31, 29];
    const existing = watchRecording(durations);
    const out = applyExistingTiming(synth(), existing);
    expect(out).not.toBeNull();
    const active = out!.exerciseSets.filter((s) => s.setType === "ACTIVE");
    expect(active.map((s) => s.duration)).toEqual(durations);
    expect(active.map((s) => s.startTime)).toEqual(
      (existing.exerciseSets as Record<string, unknown>[])
        .filter((s) => s.setType === "ACTIVE")
        .map((s) => s.startTime),
    );
  });

  it("overlays Hevy's identity, reps and weight, grouped by Hevy exercise", () => {
    const out = applyExistingTiming(synth(), watchRecording([22, 31, 29]));
    const active = out!.exerciseSets.filter((s) => s.setType === "ACTIVE");
    expect(active[0].exercises[0].category).toBe("BENCH_PRESS");
    expect(active.map((s) => s.repetitionCount)).toEqual([10, 8, 5]);
    expect(active.map((s) => s.wktStepIndex)).toEqual([0, 0, 1]); // 2 bench, then squat
  });

  it("keeps the watch's REST sets and their real durations", () => {
    const existing = watchRecording([22, 31, 29]);
    const out = applyExistingTiming(synth(), existing)!;
    expect(out.exerciseSets.length).toBe((existing.exerciseSets as unknown[]).length);
    const rest = out.exerciseSets.filter((s) => s.setType === "REST");
    expect(rest.map((s) => s.duration)).toEqual([50, 51]);
  });

  it("returns null when the ACTIVE-set counts differ", () => {
    expect(applyExistingTiming(synth(), watchRecording([22, 31]))).toBeNull();
  });

  it("returns null when there are no existing sets", () => {
    expect(applyExistingTiming(synth(), { exerciseSets: [] })).toBeNull();
    expect(applyExistingTiming(synth(), null)).toBeNull();
  });
});
