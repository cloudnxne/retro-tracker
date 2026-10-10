import { increaseStep, roundDownLoadable } from './rounding';
import type {
  ExerciseLoad,
  ExerciseSessionResult,
  LoggedSet,
  Prescription,
  Suggestion,
  Units,
} from './types';

export interface EngineConfig {
  /** Reset multiplier after two misses in a row at the same weight (plan: −10%). */
  resetFactor: number;
  /** A set is a miss when RPE >= target + this margin. */
  rpeMissMargin: number;
  /** Override the per-load-type increase (Advanced settings). */
  increaseOverride?: number;
}

export const DEFAULT_ENGINE: EngineConfig = { resetFactor: 0.9, rpeMissMargin: 1 };

type Classification = 'increase' | 'hold' | 'miss';

const doneSets = (sets: LoggedSet[]) =>
  sets.filter((s) => s.completed && s.reps != null && s.reps >= 0);

/** Heaviest completed working set; the weight progression is based on. */
export function workingWeight(result: ExerciseSessionResult): number | null {
  const kgs = doneSets(result.sets)
    .map((s) => s.kg)
    .filter((k): k is number => k != null);
  return kgs.length ? Math.max(...kgs) : null;
}

/**
 * Rows 2-4 of the progression table, evaluated top to bottom, first match wins.
 * Row 1 (reset) needs the previous session too, so it lives in suggestNext.
 */
export function classify(result: ExerciseSessionResult, cfg = DEFAULT_ENGINE): Classification {
  const rx = result.prescription;
  const sets = doneSets(result.sets);
  const rpeTooHigh = (s: LoggedSet) =>
    s.rpe != null && rx.targetRpe != null && s.rpe >= rx.targetRpe + cfg.rpeMissMargin;

  // Row 2. Prescribed sets that were never completed count as below the bottom of the range.
  if (sets.length < rx.sets) return 'miss';
  if (sets.some((s) => (s.reps ?? 0) < rx.repMin || rpeTooHigh(s))) return 'miss';

  // Row 3. A missing RPE never blocks an increase.
  const atTop = sets.every((s) => (s.reps ?? 0) >= rx.repMax);
  const rpeOk = sets.every((s) => s.rpe == null || rx.targetRpe == null || s.rpe <= rx.targetRpe);
  if (atTop && rpeOk) return 'increase';

  // Row 4.
  return 'hold';
}

const fill = (n: number, v: number) => Array.from({ length: n }, () => v);

function holdTargets(result: ExerciseSessionResult, rx: Prescription): { targets: number[]; focusSet: number } {
  const reps = doneSets(result.sets).map((s) => s.reps ?? rx.repMin);
  const targets = Array.from({ length: rx.sets }, (_, i) => reps[i] ?? rx.repMin);
  const lowest = targets.indexOf(Math.min(...targets));
  targets[lowest] = Math.min(targets[lowest] + 1, rx.repMax);
  return { targets, focusSet: lowest + 1 };
}

/**
 * Suggest the next session for one exercise.
 * @param history this exercise's past sessions, NEWEST FIRST. Deload sessions are ignored.
 * @param rx today's prescription (may differ from history if the programme changed).
 */
export function suggestNext(
  history: ExerciseSessionResult[],
  rx: Prescription,
  load: ExerciseLoad,
  units: Units,
  cfg: EngineConfig = DEFAULT_ENGINE,
): Suggestion {
  const usable = history.filter((h) => !h.isDeload && doneSets(h.sets).length > 0);
  const last = usable[0];
  const bw = load.loadType === 'bodyweight';

  if (!last) {
    return {
      outcome: 'first-time',
      weight: null,
      repTargets: fill(rx.sets, rx.repMax),
      basedOnWeight: null,
      reason: 'No history for this exercise yet.',
    };
  }

  const w = workingWeight(last);
  const cls = classify(last, cfg);

  if (cls === 'miss') {
    const prev = usable[1];
    if (prev && classify(prev, cfg) === 'miss' && workingWeight(prev) === w) {
      if (bw || w == null) {
        return {
          outcome: 'reset',
          weight: w,
          repTargets: fill(rx.sets, Math.max(1, rx.repMin - 1)),
          basedOnWeight: w,
          reason: 'Two sessions in a row under target. Easing the rep target to build back up.',
        };
      }
      return {
        outcome: 'reset',
        weight: roundDownLoadable(w * cfg.resetFactor, load, units),
        repTargets: fill(rx.sets, rx.repMin),
        basedOnWeight: w,
        reason: `Two sessions in a row under target at ${w}. Dropping ${Math.round((1 - cfg.resetFactor) * 100)}% to build back up.`,
      };
    }
    return {
      outcome: 'miss',
      weight: w,
      repTargets: fill(rx.sets, rx.repMin),
      basedOnWeight: w,
      reason:
        rx.targetRpe != null
          ? `A set came in under ${rx.repMin} reps or at RPE ${rx.targetRpe + cfg.rpeMissMargin}+. Same weight again.`
          : `A set came in under ${rx.repMin} reps. Same weight again.`,
    };
  }

  if (cls === 'increase') {
    if (bw || w == null) {
      return {
        outcome: 'increase',
        weight: w,
        repTargets: fill(rx.sets, rx.repMax + 1),
        basedOnWeight: w,
        reason: `Every set hit ${rx.repMax}. Adding a rep.`,
      };
    }
    const step = cfg.increaseOverride ?? increaseStep(load, units);
    return {
      outcome: 'increase',
      weight: roundDownLoadable(w + step, load, units),
      repTargets: fill(rx.sets, rx.repMin),
      basedOnWeight: w,
      reason: `Every set hit ${rx.repMax}${rx.targetRpe != null ? ` at RPE ${rx.targetRpe} or easier` : ''}. Adding ${step} ${units}.`,
    };
  }

  const { targets, focusSet } = holdTargets(last, rx);
  return {
    outcome: 'hold',
    weight: w,
    repTargets: targets,
    focusSet,
    basedOnWeight: w,
    reason: `All sets in the ${rx.repMin}–${rx.repMax} range. Same weight, one more rep on your weakest set.`,
  };
}

export interface DeloadConfig {
  /** Fraction of the working weight used in a deload (plan: 60%). */
  loadFactor: number;
  setsRemoved: number;
}

export const DEFAULT_DELOAD: DeloadConfig = { loadFactor: 0.6, setsRemoved: 1 };

/** Deload transform applied on top of the normal suggestion's base weight. */
export function deloadPrescription(
  baseWeight: number | null,
  rx: Prescription,
  load: ExerciseLoad,
  units: Units,
  cfg: DeloadConfig = DEFAULT_DELOAD,
): { weight: number | null; sets: number } {
  const sets = Math.max(1, rx.sets - cfg.setsRemoved);
  if (baseWeight == null || load.loadType === 'bodyweight') return { weight: baseWeight, sets };
  return { weight: roundDownLoadable(baseWeight * cfg.loadFactor, load, units), sets };
}
