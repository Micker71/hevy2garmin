/**
 * Merge a Hevy workout into the Garmin activity the user's watch recorded.
 *
 * This is the piece the web engine never had. It renamed the activity and wrote
 * a description, so every watch strategy behaved like `describe`, and the Merge
 * setting in Settings was wired to nothing. Two users reported that as a broken
 * tool (#495, #565), which it was.
 *
 * Ported from `attempt_merge` in `src/hevy2garmin/merge.py`. The three
 * strategies are unchanged:
 *
 *   describe  keep the watch activity, only write its description. No sets.
 *   merge     push the sets INTO the watch activity and keep it, so the watch's
 *             own metrics (HR, training effect, body battery) survive. Garmin
 *             will not display exercise NAMES on a device-recorded activity, so
 *             they read as "Unknown" while the reps and weights do land (#325).
 *   replace   upload a named activity and delete the watch copy. Real names, at
 *             the cost of the watch-only metrics.
 */
import {
  findMergeMatch,
  mergeSearchRange,
  type CandidateActivity,
  type MergeMatchOptions,
  type TimedWorkout,
} from "../merge-match";
import {
  applyExistingTiming,
  buildExerciseSetsPayload,
  pushWithNameFallback,
  type SetTiming,
} from "../exercise-sets";
import type { GarminGateway } from "./gateway";

export type WatchStrategy = "merge" | "replace" | "describe";

export const DEFAULT_WATCH_STRATEGY: WatchStrategy = "merge";

/** Strategies that keep the watch's own activity rather than replacing it. */
const IN_PLACE: ReadonlySet<string> = new Set(["merge", "describe"]);

export function isWatchStrategy(v: unknown): v is WatchStrategy {
  return v === "merge" || v === "replace" || v === "describe";
}

/** Garmin marks our own uploads DEVELOPMENT; anything else came from a device. */
export function isWatchRecorded(activity: Pick<CandidateActivity, "manufacturer">): boolean {
  const m = String(activity.manufacturer ?? "").toUpperCase();
  return m !== "" && m !== "DEVELOPMENT";
}

export interface MergeOptions extends MergeMatchOptions {
  /**
   * How long to wait before reading the sets back to check Garmin kept the
   * exercise names. Injectable so tests do not sleep; production uses
   * `DEFAULT_VERIFY_DELAY_MS`.
   */
  verifyDelayMs?: number;
  strategy?: WatchStrategy;
  /** User overrides for exercises the built-in table does not cover. */
  customMappings?: Record<string, [number, number]>;
  /**
   * How long a set and its rest are assumed to last. The user's Timing
   * settings, so a merged workout is laid out the way an uploaded one is.
   */
  timing?: Partial<SetTiming>;
  /**
   * On a watch activity, keep the watch's own per-set execution and rest timing
   * and write only Hevy's names, reps and weights (#748). Default true. Set
   * false to sync the synthesized timing too, the pre-#748 behavior.
   */
  preserveWatchTiming?: boolean;
}

export interface MergeOutcome {
  /** Did we act on a watch activity at all? */
  merged: boolean;
  /**
   * The matched Garmin activity. Set on every outcome that found one, merged
   * or not, and unset only when no activity was found or none was looked for.
   * `syncOneWorkout`'s merge-only mode relies on exactly that split.
   */
  activityId?: number;
  strategy?: WatchStrategy;
  /** Set when merged is false, so the caller can log why it fell through. */
  reason?: string;
  /** True when the caller should upload its own activity and delete this one. */
  replaceWatchActivity?: boolean;
  /**
   * True when the merge was undone and the caller must upload a fresh named
   * activity, skipping the start-time lookup. Set when Garmin accepted the sets
   * and silently dropped their names, which leaves the matched activity worse
   * than before, so it is restored and the workout gets a real upload instead.
   */
  forceFreshUpload?: boolean;
  /** How many ACTIVE sets were pushed, for the sync log and for tests. */
  setsPushed?: number;
}

/** How long to let Garmin process a PUT before reading the sets back. */
export const DEFAULT_VERIFY_DELAY_MS = 4000;

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Did Garmin actually keep the exercise identities after the PUT?
 *
 * Garmin accepts the sets and can silently drop the category, leaving every set
 * as "Choose an Exercise" (#159, confirmed live). Ported from `_names_applied`
 * in `merge.py:53-75`, including two rules that look contradictory and are not.
 *
 * A successful read with no ACTIVE categories at all returns FALSE: that is
 * evidence the names are gone. A read that THROWS returns TRUE: an exception
 * says nothing about what Garmin kept, and failing closed there would discard a
 * merge that probably worked because of a transient error.
 *
 * "Applied" is any surviving real category, not all of them. A partial drop
 * still leaves a usable activity, and discarding it would cost the user the
 * sets that did land.
 */
async function namesApplied(
  gateway: GarminGateway,
  activityId: number,
  delayMs: number,
): Promise<boolean> {
  await sleep(delayMs);
  let after: Record<string, unknown>;
  try {
    after = await gateway.exerciseSets(activityId);
  } catch {
    return true;
  }
  const sets = (after?.exerciseSets as Array<Record<string, unknown>> | undefined) ?? [];
  const cats: unknown[] = [];
  for (const s of sets) {
    if (s?.setType !== "ACTIVE") continue;
    for (const e of (s.exercises as Array<Record<string, unknown>> | undefined) ?? []) {
      cats.push(e?.category);
    }
  }
  if (!cats.length) return false;
  return cats.some((c) => c && c !== "UNKNOWN");
}

/**
 * Try to fold a Hevy workout into a matching watch activity.
 *
 * Returns `merged: false` with a reason whenever there is nothing to do, so the
 * caller falls back to its normal upload. It never throws for "no match": that
 * is the common case, not an error.
 *
 * For `replace` it does NOT upload or delete anything itself. It reports the
 * matched activity and sets `replaceWatchActivity`, leaving both writes to the
 * caller, which already owns uploading and is the only place that knows whether
 * this is a dry run.
 */
/** Consecutive `exerciseSets` PUT failures before merge stops trying. */
export const MERGE_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * The durable state a merge needs, kept deliberately narrow.
 *
 * Not a general key-value door onto `app_cache`. The store interface exists so
 * the engine cannot reach past it, and a general getter would hand every future
 * caller the ability to write anywhere.
 *
 * Every method is optional so a consumer without durable storage still works,
 * with the guards degrading to what they were before rather than throwing.
 */
export interface MergeStore {
  /** The pre-merge sets, readable on a later run and from another process. */
  loadMergeBackup?(activityId: number): Promise<Record<string, unknown> | null>;
  saveMergeBackup?(activityId: number, sets: Record<string, unknown>): Promise<void>;
  clearMergeBackup?(activityId: number): Promise<void>;
  /** Consecutive PUT failures, for the circuit breaker. */
  loadMergeFailures?(): Promise<number>;
  saveMergeFailures?(count: number): Promise<void>;
}

export interface MergeDeps {
  store?: MergeStore;
}

export async function mergeIntoWatchActivity(
  gateway: GarminGateway,
  workout: TimedWorkout & { exercises?: unknown[] },
  options: MergeOptions = {},
  deps: MergeDeps = {},
): Promise<MergeOutcome> {
  const strategy = options.strategy ?? DEFAULT_WATCH_STRATEGY;
  const store = deps.store;

  // Checked before anything else, including the activity listing, because the
  // listing is itself a rate-limited Garmin call and repeating it for every
  // workout is half of what this guard is for. Python reads it in the same
  // place (`merge.py:419-422`).
  if (store?.loadMergeFailures) {
    const failures = await store.loadMergeFailures().catch(() => 0);
    if (failures >= MERGE_MAX_CONSECUTIVE_FAILURES) {
      return {
        merged: false,
        reason: `circuit breaker: ${failures} consecutive exerciseSets failures, merge disabled for now`,
      };
    }
  }

  const range = mergeSearchRange(workout);
  if (!range) return { merged: false, reason: "workout has no usable start or end time" };

  let candidates: CandidateActivity[];
  try {
    candidates = await gateway.activitiesByDate(range.start, range.end);
  } catch (e) {
    // A failed lookup is not "no match": say so, so the caller does not record
    // a clean fall-through for what was actually a Garmin outage.
    return { merged: false, reason: `could not list Garmin activities: ${(e as Error).message}` };
  }

  const match = findMergeMatch(workout, candidates ?? [], options);
  if (!match) return { merged: false, reason: "no matching Garmin activity found" };

  const act = match.activity;
  // Our own uploads are merged into as well. Refusing them meant a user who
  // edited a workout in Hevy and re-synced got the title and description
  // updated and the sets left as they were, because the fall-through does
  // rename and describe only. Python merges here too (`merge.py:450-451`), and
  // the read-back in `pushSetsIntoActivity` is the safeguard that comes with it
  // (#597).
  if (!IN_PLACE.has(strategy)) {
    return { merged: false, activityId: act.activityId, strategy, replaceWatchActivity: true };
  }
  if (strategy === "describe") {
    // Nothing to push. The caller writes the description, as it already does.
    return { merged: true, activityId: act.activityId, strategy, setsPushed: 0 };
  }

  return pushSetsIntoActivity(gateway, workout, act, options, deps);
}

/**
 * Push a workout's sets into one known Garmin activity, with the backup before
 * the PUT and the read-back after it.
 *
 * The second half of `mergeIntoWatchActivity`, callable on its own by a resync,
 * which already knows its activity and must not search for one. `strategy`
 * here only decides the read-back: under `merge`, a watch activity is not read
 * back, and every other activity is.
 */
export async function pushSetsIntoActivity(
  gateway: GarminGateway,
  workout: TimedWorkout & { exercises?: unknown[] },
  act: CandidateActivity,
  options: MergeOptions = {},
  deps: MergeDeps = {},
): Promise<MergeOutcome> {
  const strategy = options.strategy ?? DEFAULT_WATCH_STRATEGY;
  const preserveWatchTiming = options.preserveWatchTiming ?? true;
  const store = deps.store;
  const isWatch = isWatchRecorded(act);

  const startTime = act.startTimeGMT || act.startTimeLocal || "";
  const durationS = act.duration ?? 0;
  if (!startTime || durationS <= 0) {
    return {
      merged: false,
      activityId: act.activityId,
      strategy,
      reason: "matched activity is missing a start time or duration",
    };
  }

  let payload = buildExerciseSetsPayload(
    workout as { exercises?: never[] },
    act.activityId,
    startTime,
    durationS,
    options.customMappings,
    options.timing,
  );
  if (!payload.exerciseSets.length) {
    return { merged: false, activityId: act.activityId, strategy, reason: "workout has no sets to push" };
  }

  // Back up first. A merge replaces ALL sets on the activity, so without this a
  // failed push leaves the user with neither their watch's sets nor ours.
  let backup: Record<string, unknown> | null = null;
  try {
    backup = await gateway.exerciseSets(act.activityId);
  } catch {
    backup = null; // best effort; the merge does not depend on it
  }

  // Durably, before the PUT. A backup that lives only in this closure covers a
  // throw from the push and nothing else, and the case that matters is the
  // process dying between the PUT landing and the restore, which on a
  // serverless request is an ordinary timeout. Same key shape as Python's
  // `merge_backup_<id>` so either stack can read the other's (#598).
  if (backup && store?.saveMergeBackup) {
    await store.saveMergeBackup(act.activityId, backup).catch(() => {});
  }

  // Keep the watch's own per-set execution and rest timing when we can (#748).
  // Only for a watch recording: a DEVELOPMENT activity's existing sets are a
  // previous hevy2garmin upload, not real device timing. applyExistingTiming
  // returns null when the watch and Hevy disagree on how many sets there were,
  // so the synthesized timing stands rather than a wrong mapping.
  if (preserveWatchTiming && isWatch) {
    const preserved = applyExistingTiming(payload, backup);
    if (preserved) payload = preserved;
  }

  try {
    await pushWithNameFallback((p) => gateway.putExerciseSets(act.activityId, p), payload);
  } catch (e) {
    if (backup && Array.isArray((backup as { exerciseSets?: unknown }).exerciseSets)) {
      try {
        await gateway.putExerciseSets(act.activityId, backup);
      } catch {
        // Restoring is best effort too; the original error is the one to report.
        // The durable copy is deliberately LEFT in place here so a later run
        // can still put the original sets back.
      }
    }
    // Only a PUT failure counts toward the breaker. A workout with no matching
    // activity is an ordinary outcome, and counting it would disable merge for
    // everyone whose watch simply was not recording.
    if (store?.saveMergeFailures) {
      const failures = store.loadMergeFailures ? await store.loadMergeFailures().catch(() => 0) : 0;
      await store.saveMergeFailures(failures + 1).catch(() => {});
    }
    return {
      merged: false,
      activityId: act.activityId,
      strategy,
      reason: `exerciseSets push failed: ${(e as Error).message}`,
    };
  }

  // Verify, except for a watch activity under `merge`. There we keep the watch
  // recording knowing Garmin will not display our names on it, so verifying
  // would restore and throw away a merge we meant to keep. On our own upload
  // the activity exists only to carry these sets, so a silent drop has to be
  // caught (`merge.py:545-556`).
  if (!(isWatch && strategy === "merge")) {
    const applied = await namesApplied(
      gateway,
      act.activityId,
      options.verifyDelayMs ?? DEFAULT_VERIFY_DELAY_MS,
    );
    if (!applied) {
      // Prefer the durable copy, so a restore behaves the same whether it
      // happens inline or on a later run.
      const original = (store?.loadMergeBackup ? await store.loadMergeBackup(act.activityId).catch(() => null) : null) ?? backup;
      if (original && Array.isArray((original as { exerciseSets?: unknown }).exerciseSets)) {
        try {
          await gateway.putExerciseSets(act.activityId, original);
        } catch {
          // Best effort. The outcome below is the one that matters.
        }
      }
      if (store?.clearMergeBackup) await store.clearMergeBackup(act.activityId).catch(() => {});
      return {
        merged: false,
        activityId: act.activityId,
        strategy,
        forceFreshUpload: true,
        reason: "Garmin dropped the exercise names; restored and uploading a named activity instead",
      };
    }
  }

  // The merge landed. Drop the backup, because a stale one is worse than none:
  // a later restore would put back sets from a merge that has been superseded.
  if (store?.clearMergeBackup) await store.clearMergeBackup(act.activityId).catch(() => {});
  if (store?.saveMergeFailures) await store.saveMergeFailures(0).catch(() => {});

  return {
    merged: true,
    activityId: act.activityId,
    strategy,
    setsPushed: payload.exerciseSets.filter((s) => s.setType === "ACTIVE").length,
  };
}
