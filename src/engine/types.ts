export type Units = 'kg' | 'lb';
/**
 * machine = a weight stack (moves in stack steps). plates = a plate-loaded machine (leg press,
 * hack squat, T-bar…): loaded with the lifter's plates like a barbell, but with no bar, so the
 * logged weight is the plates on it.
 */
export type LoadType = 'barbell' | 'dumbbell' | 'machine' | 'plates' | 'bodyweight';

export interface ExerciseLoad {
  loadType: LoadType;
  /** Machine stack step. Ignored for other load types. */
  loadIncrement?: number;
  /** Barbell only. Defaults to 20 kg / 45 lb. */
  barWeight?: number;
  /** Barbell only: plate sizes this lifter has (pairs). Defaults to a full set. */
  plates?: number[];
}

/** What the programme asks for on one exercise. */
export interface Prescription {
  sets: number;
  repMin: number;
  repMax: number;
  /** Target RPE, or null when the programme doesn't use RPE. */
  targetRpe: number | null;
}

/** One logged working set (warm-ups are filtered out before the engine sees them). */
export interface LoggedSet {
  kg: number | null;
  reps: number | null;
  rpe: number | null;
  completed: boolean;
}

/** One past session of a single exercise, newest first when passed as history. */
export interface ExerciseSessionResult {
  sets: LoggedSet[];
  isDeload: boolean;
  prescription: Prescription;
}

export type Outcome = 'increase' | 'hold' | 'miss' | 'reset' | 'first-time';

export interface Suggestion {
  outcome: Outcome;
  /** Suggested working weight in the athlete's units. null = ask the user (first time). */
  weight: number | null;
  /** Rep target per set. Hold asks for +1 rep on the lowest set. */
  repTargets: number[];
  /** 1-based set to push for one more rep (Hold only). */
  focusSet?: number;
  /** Weight the suggestion was derived from, for the "why" sheet. */
  basedOnWeight: number | null;
  /** Plain-English rule that fired, for the "why" sheet. */
  reason: string;
}
