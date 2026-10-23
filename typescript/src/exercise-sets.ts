/**
 * Build and land the `exerciseSets` payload that puts a Hevy workout's sets,
 * reps and weights INTO a Garmin activity the user's watch recorded.
 *
 * Ported from `src/hevy2garmin/merge.py`. This is what the web engine was
 * missing entirely: it renamed the activity and wrote a description, so the
 * Merge setting behaved exactly like Describe and two users reported the tool
 * as broken (#495, #565).
 *
 * Two things here are easy to get wrong and both have tests:
 *
 *  1. Garmin renders an exercise whose name it does not recognise as
 *     "Unknown", but accepts a NULL name under a valid parent category and
 *     shows the category's generic label. So an unresolved subcategory must
 *     send no name rather than a guess.
 *  2. The PUT is atomic and reports no per-exercise error. One rejected
 *     (category, subcategory) pair 400s the entire payload, which would drop
 *     every set. `pushExerciseSets` bisects to find the offender and strips
 *     only its name, keeping every other exercise named.
 */
import { lookupExercise, UNKNOWN_CATEGORY } from "./mapper";
import { fitExerciseStrings } from "./exercise-strings";
import { toUtcDate } from "./match";

/** FIT exercise category id → the string Garmin's exerciseSets API expects. */
const CATEGORY_NAMES: Record<number, string> = {
  0: "BENCH_PRESS", 1: "CALF_RAISE", 2: "CARDIO", 3: "CARRY", 4: "CHOP",
  5: "CORE", 6: "CRUNCH", 7: "CURL", 8: "DEADLIFT", 9: "FLYE",
  10: "HIP_RAISE", 11: "HIP_STABILITY", 12: "HIP_SWING", 13: "HYPEREXTENSION",
  14: "LATERAL_RAISE", 15: "LEG_CURL", 16: "LEG_RAISE", 17: "LUNGE",
  18: "OLYMPIC_LIFT", 19: "PLANK", 20: "PLYO", 21: "PULL_UP", 22: "PUSH_UP",
  23: "ROW", 24: "SHOULDER_PRESS", 25: "SHOULDER_STABILITY", 26: "SHRUG",
  27: "SIT_UP", 28: "SQUAT", 29: "TOTAL_BODY", 30: "TRICEPS_EXTENSION",
  31: "WARM_UP", 32: "RUN", [UNKNOWN_CATEGORY]: "UNKNOWN",
};

export function categoryToString(catId: number): string {
  return CATEGORY_NAMES[catId] ?? "UNKNOWN";
}

// Set/rest timing defaults, the same profile fit.ts uses.
/**
 * How long a set and the rest after it are assumed to last.
 *
 * The same four numbers the FIT encoder uses, and the same four the Settings
 * page offers under Timing. They are defaults, not constants: a user who rests
 * three minutes between sets lays their workout out differently from one who
 * rests one, and a merged workout should look like the uploaded one.
 */
export interface SetTiming {
  workingSetS: number;
  warmupSetS: number;
  restSetsS: number;
  restExercisesS: number;
}

export const DEFAULT_SET_TIMING: SetTiming = {
  workingSetS: 40,
  warmupSetS: 25,
  restSetsS: 75,
  restExercisesS: 120,
};

export interface ExercisePayloadEntry {
  category: string;
  name: string | null;
  probability: number;
}

export interface ExerciseSet {
  exercises: ExercisePayloadEntry[];
  duration: number;
  setType: "ACTIVE" | "REST";
  startTime: string;
  wktStepIndex: number;
  messageIndex: number;
  repetitionCount?: number;
  weight?: number;
}

export interface ExerciseSetsPayload {
  activityId: number;
  exerciseSets: ExerciseSet[];
}

interface HevySet {
  type?: string;
  reps?: number | null;
  weight_kg?: number | null;
  duration_seconds?: number | null;
}

interface HevyExercise {
  title?: string;
  name?: string;
  exercise_template_id?: string | null;
  sets?: HevySet[];
}

/**
 * Convert a Hevy workout into a Garmin `exerciseSets` PUT payload, spreading the
 * sets across the matched activity's real timeline.
 *
 * Timing is scaled so the sets span the activity rather than the nominal set
 * durations: the ideal total is compared with the activity's actual duration and
 * the ratio is clamped to 0.3..2.0, exactly as the Python does.
 */
export function buildExerciseSetsPayload(
  workout: { exercises?: HevyExercise[] },
  activityId: number,
  activityStartTime: string,
  activityDurationS: number,
  customMappings?: Record<string, [number, number]>,
  timing?: Partial<SetTiming>,
): ExerciseSetsPayload {
  // Only real numbers override a default. A caller that builds the object from
  // optional settings can pass `undefined` for a value the user never set, and
  // spreading that over the default made every set time NaN, so the date
  // conversion below threw "Invalid time value" (#703).
  const t: SetTiming = { ...DEFAULT_SET_TIMING };
  for (const [k, v] of Object.entries(timing ?? {})) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) t[k as keyof SetTiming] = v;
  }
  const exercises = workout.exercises ?? [];
  if (!exercises.length) return { activityId, exerciseSets: [] };

  const actStart = toUtcDate(activityStartTime);
  if (!actStart) return { activityId, exerciseSets: [] };

  interface Planned { exIdx: number; set: HevySet; setDur: number; restDur: number }
  const all: Planned[] = [];
  exercises.forEach((ex, exIdx) => {
    const sets = ex.sets ?? [];
    sets.forEach((s, sIdx) => {
      const isWarmup = (s.type ?? "normal") === "warmup";
      const explicit = s.duration_seconds;
      const setDur = explicit && explicit > 0 ? Number(explicit) : isWarmup ? t.warmupSetS : t.workingSetS;
      const isLastSet = sIdx === sets.length - 1;
      const isLastExercise = exIdx === exercises.length - 1;
      const restDur = isLastSet && isLastExercise ? 0 : isLastSet ? t.restExercisesS : t.restSetsS;
      all.push({ exIdx, set: s, setDur, restDur });
    });
  });

  const idealTotal = all.reduce((t, p) => t + p.setDur + p.restDur, 0);
  const rawScale = idealTotal > 0 ? activityDurationS / idealTotal : 1.0;
  const scale = Math.max(0.3, Math.min(2.0, rawScale));

  const exerciseSets: ExerciseSet[] = [];
  let msgIdx = 0;
  let cursorS = 0;
  const at = (offsetS: number) =>
    new Date(actStart.getTime() + offsetS * 1000).toISOString().replace(/\.\d+Z$/, ".0");

  for (const p of all) {
    const ex = exercises[p.exIdx];
    const { category, subcategory } = lookupExercise(
      ex.title || ex.name || "Unknown",
      ex.exercise_template_id,
      customMappings,
    );
    let categoryStr = categoryToString(category);
    let subName = fitExerciseStrings(category, subcategory)[1];

    // Garmin rejects an UNKNOWN category, so fall back to the generic TOTAL_BODY
    // parent. Never send the parent name as the exercise NAME: an unrecognised
    // name renders as "Unknown" (#138), while a null name under a valid parent
    // is accepted and shown as the category's generic label.
    if (categoryStr === "UNKNOWN") {
      categoryStr = "TOTAL_BODY";
      subName = null;
    }

    const scaledDur = p.setDur * scale;
    const reps = p.set.reps;
    const weightKg = p.set.weight_kg;

    exerciseSets.push({
      // probability must be non-zero: Connect renders any exercise whose stored
      // confidence is 0 as "Unknown" (#325). The web UI's own edits send 100.
      exercises: [{ category: categoryStr, name: subName, probability: 100 }],
      duration: Math.round(scaledDur * 1000) / 1000,
      repetitionCount: reps != null ? Math.trunc(reps) : 0,
      weight: weightKg ? Math.round(weightKg * 1000) : 0,
      setType: "ACTIVE",
      startTime: at(cursorS),
      wktStepIndex: p.exIdx,
      messageIndex: msgIdx,
    });
    msgIdx += 1;
    cursorS += scaledDur;

    if (p.restDur > 0) {
      const scaledRest = p.restDur * scale;
      exerciseSets.push({
        exercises: [],
        duration: Math.round(scaledRest * 1000) / 1000,
        setType: "REST",
        startTime: at(cursorS),
        wktStepIndex: p.exIdx,
        messageIndex: msgIdx,
      });
      msgIdx += 1;
      cursorS += scaledRest;
    }
  }

  return { activityId, exerciseSets };
}

/**
 * Keep the watch's own per-set execution and rest timing, writing only Hevy's
 * names, reps and weights onto it (#748).
 *
 * `buildExerciseSetsPayload` invents a uniform duration for every set, because
 * Hevy's API sends none, and scales them to the activity, so each set ends the
 * same length (the 33 seconds the reporter saw). When the workout was recorded
 * on both the watch and Hevy, the watch's timing is the real one, so this takes
 * the watch's whole set list unchanged and overlays Hevy's identity onto the
 * ACTIVE sets, matched by ACTIVE-set position.
 *
 * Returns null when the two have a different number of ACTIVE sets: there is no
 * sound 1:1 mapping then, so the caller keeps the synthesized timing instead of
 * guessing. `existing` is the activity's current sets, as `gateway.exerciseSets`
 * returns them.
 */
export function applyExistingTiming(
  payload: ExerciseSetsPayload,
  existing: Record<string, unknown> | null | undefined,
): ExerciseSetsPayload | null {
  const existingSets =
    (existing?.exerciseSets as Array<Record<string, unknown>> | undefined) ?? [];
  if (!existingSets.length) return null;

  const synthActive = payload.exerciseSets.filter((s) => s.setType === "ACTIVE");
  const watchActive = existingSets.filter((s) => s.setType === "ACTIVE");
  if (!watchActive.length || watchActive.length !== synthActive.length) return null;

  const out: ExerciseSet[] = [];
  let ai = 0;
  for (const es of existingSets) {
    if (es.setType === "ACTIVE") {
      const h = synthActive[ai];
      ai += 1;
      out.push({
        // Identity, reps and weight from Hevy; the wktStepIndex too, so the sets
        // group under their Hevy exercise rather than the watch's own grouping.
        exercises: h.exercises,
        repetitionCount: h.repetitionCount ?? 0,
        weight: h.weight ?? 0,
        wktStepIndex: h.wktStepIndex,
        // Timing exactly as the watch recorded it.
        duration: Number(es.duration),
        startTime: String(es.startTime),
        setType: "ACTIVE",
        messageIndex: Number(es.messageIndex),
      });
    } else {
      // A REST (or any non-ACTIVE) set is the watch's own, kept so its real rest
      // duration survives.
      out.push({
        exercises: (es.exercises as ExercisePayloadEntry[]) ?? [],
        duration: Number(es.duration),
        setType: "REST",
        startTime: String(es.startTime),
        wktStepIndex: Number(es.wktStepIndex ?? 0),
        messageIndex: Number(es.messageIndex),
      });
    }
  }
  return { activityId: payload.activityId, exerciseSets: out };
}

/** True when Garmin refused an exercise's (category, subcategory) pair. */
export function isSubcategoryRejection(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return msg.includes("sub-category") || msg.includes("subcategory") || msg.includes("invalid sub");
}

/** A copy with every exercise NAME removed, categories kept. */
export function stripExerciseNames(payload: ExerciseSetsPayload): ExerciseSetsPayload {
  return {
    ...payload,
    exerciseSets: payload.exerciseSets.map((s) => ({
      ...s,
      exercises: s.exercises.map((ex) => ({ ...ex, name: null })),
    })),
  };
}

/** Distinct `category|name` of named exercises, in first-seen order. */
export function namedExerciseKeys(payload: ExerciseSetsPayload): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const s of payload.exerciseSets) {
    for (const ex of s.exercises) {
      if (ex.name == null) continue;
      const k = `${ex.category}|${ex.name}`;
      if (!seen.has(k)) { seen.add(k); keys.push(k); }
    }
  }
  return keys;
}

/** A copy with the name removed only for exercises whose key is in `bad`. */
export function stripNamesFor(payload: ExerciseSetsPayload, bad: Set<string>): ExerciseSetsPayload {
  return {
    ...payload,
    exerciseSets: payload.exerciseSets.map((s) => ({
      ...s,
      exercises: s.exercises.map((ex) =>
        ex.name != null && bad.has(`${ex.category}|${ex.name}`) ? { ...ex, name: null } : ex,
      ),
    })),
  };
}

/**
 * Land the sets, keeping as many exercise names as possible.
 *
 * Garmin's PUT is atomic and names no offender, so when it rejects a name as an
 * invalid sub-category we bisect the distinct named exercises: strip a half,
 * retry, and narrow. Bounded to about log2(n) extra PUTs and only on this rare
 * path. If it cannot converge, because several offenders are split across
 * halves, it strips every name, which still lands the sets.
 *
 * Any error that is not a subcategory rejection is rethrown untouched. Losing
 * every set to a swallowed error is the failure this whole file exists to avoid.
 */
export async function pushWithNameFallback(
  put: (payload: ExerciseSetsPayload) => Promise<void>,
  payload: ExerciseSetsPayload,
): Promise<void> {
  try {
    await put(payload);
    return;
  } catch (e) {
    if (!isSubcategoryRejection(e)) throw e;
  }

  const keys = namedExerciseKeys(payload);
  if (keys.length <= 1) {
    await put(stripExerciseNames(payload));
    return;
  }

  let cand = keys;
  while (cand.length > 1) {
    const mid = Math.floor(cand.length / 2);
    const head = cand.slice(0, mid);
    try {
      await put(stripNamesFor(payload, new Set(head)));
      cand = head; // stripping the head fixed it, so the offender is in the head
    } catch (e) {
      if (!isSubcategoryRejection(e)) throw e;
      cand = cand.slice(mid); // still rejected, so the offender is in the tail
    }
  }

  try {
    await put(stripNamesFor(payload, new Set(cand)));
  } catch (e) {
    if (!isSubcategoryRejection(e)) throw e;
    await put(stripExerciseNames(payload));
  }
}
