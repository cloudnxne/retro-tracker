/**
 * Epley estimated 1RM. Matches the PHP tracker's PR maths (reps === 1 returns the load).
 * Pass maxReps to exclude high-rep sets (the FUEL insight uses 10).
 */
export function e1rm(kg: number, reps: number, maxReps = Infinity): number | null {
  if (!(kg > 0) || !(reps > 0) || reps > maxReps) return null;
  if (reps === 1) return kg;
  return Math.round(kg * (1 + reps / 30) * 10) / 10;
}

/** Best e1RM across completed sets (the one definition PRs, PROGRESS and insights share). */
export function bestE1rm(sets: { kg: number | null; reps: number | null; completed: boolean }[], maxReps = Infinity): number | null {
  let best: number | null = null;
  for (const s of sets) {
    if (!s.completed) continue;
    const v = e1rm(s.kg ?? 0, s.reps ?? 0, maxReps);
    if (v != null && (best == null || v > best)) best = v;
  }
  return best;
}
