import type { Units } from '../engine/types';
import { convert, type ImportExercise, type ImportSet, type ImportWorkout, type ParsedImport, type RowError } from './strong';

/**
 * The original PHP tracker: one JSON file per saved workout, e.g.
 *   { date: "2026-09-21", completedAt: "2026-09-21T07:27:22.916Z", phase: "ph1" | "deload", day: "mon",
 *     sessionName: "Mon - Squat", exercises: [{ name, sets: [{ label: "W" | "1", targetKg, targetReps: "4–6",
 *     loggedKg, loggedReps, loggedRpe, completed }] }] }
 * Programme templates ({ phase, day, exercises } with no date) are recognised and skipped.
 *
 * Rules:
 * - The same day saved twice (re-saves) → the latest save wins.
 * - An unticked set counts only if its numbers were changed from the prefilled target ("I edited it, so I
 *   did it"). Untouched prefilled sets are skipped and counted.
 */

interface LogSet {
  label?: string;
  targetKg?: number | null;
  targetReps?: string | number | null;
  loggedKg?: number | null;
  loggedReps?: number | null;
  loggedRpe?: number | null;
  completed?: boolean;
}
interface LogExercise {
  name?: string;
  sets?: LogSet[];
}
interface TrackerLog {
  date: string;
  completedAt: string;
  phase?: string;
  day?: string;
  sessionName?: string;
  exercises: LogExercise[];
}

const DATE = /^\d{4}-\d\d-\d\d$/;

export function isTrackerLog(j: unknown): j is TrackerLog {
  const o = j as Partial<TrackerLog> | null;
  return !!o && typeof o === 'object' && typeof o.date === 'string' && DATE.test(o.date) && typeof o.completedAt === 'string' && Array.isArray(o.exercises);
}

export function isTrackerTemplate(j: unknown): boolean {
  const o = j as { date?: unknown; phase?: unknown; day?: unknown; exercises?: unknown } | null;
  return !!o && typeof o === 'object' && o.date === undefined && typeof o.phase === 'string' && typeof o.day === 'string' && Array.isArray(o.exercises);
}

/** "4–6" → 4, "12" → 12, 6 → 6; null when there's no number. */
function minReps(t: LogSet['targetReps']): number | null {
  const m = /\d+/.exec(String(t ?? ''));
  return m ? Number(m[0]) : null;
}

/** An unticked set whose logged numbers still equal the prefilled target was never done. */
export function changedFromTarget(s: LogSet): boolean {
  const kgChanged = (s.loggedKg ?? null) !== (s.targetKg ?? null);
  const target = minReps(s.targetReps);
  const repsChanged = target != null && s.loggedReps != null && s.loggedReps !== target;
  return kgChanged || repsChanged;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Parse every picked JSON file. `files` = [name, parsed JSON | parse error]. */
export function parseTrackerLogs(files: { name: string; json: unknown }[], accountUnits: Units): ParsedImport {
  const errors: RowError[] = [];
  const skipped = { restTimers: 0, notes: 0, cardio: 0, untickedUnchanged: 0, duplicateSaves: 0, templates: 0 };
  const latest = new Map<string, { log: TrackerLog; file: string }>();

  // A combined file (an array of logs) counts as one file per log.
  const flat = files.flatMap(({ name, json }) => (Array.isArray(json) ? json.map((j, k) => ({ name: `${name}[${k}]`, json: j })) : [{ name, json }]));
  flat.forEach(({ name, json }, i) => {
    if (isTrackerTemplate(json)) return void skipped.templates++;
    if (!isTrackerLog(json)) return void errors.push({ row: i + 1, message: `${name}: not a workout log` });
    const key = `${json.date}|${json.day ?? json.sessionName ?? ''}`;
    const prev = latest.get(key);
    if (prev) {
      skipped.duplicateSaves++;
      if (Date.parse(prev.log.completedAt) >= Date.parse(json.completedAt)) return;
    }
    latest.set(key, { log: json, file: name });
  });

  let setCount = 0;
  const workouts: ImportWorkout[] = [];
  for (const [key, { log, file }] of latest) {
    const completedAt = Date.parse(log.completedAt);
    if (Number.isNaN(completedAt)) {
      errors.push({ row: 0, message: `${file}: completedAt "${log.completedAt}" not recognised` });
      continue;
    }
    const exercises: ImportExercise[] = [];
    for (const e of log.exercises) {
      const name = String(e.name ?? '').trim();
      if (!name || !Array.isArray(e.sets)) continue;
      const sets: ImportSet[] = [];
      for (const s of e.sets) {
        if (!s.completed && !changedFromTarget(s)) {
          skipped.untickedUnchanged++;
          continue;
        }
        const kg = num(s.loggedKg);
        const reps = num(s.loggedReps);
        if (kg == null && reps == null) continue;
        const rpe = num(s.loggedRpe);
        sets.push({
          setType: String(s.label ?? '').toUpperCase() === 'W' ? 'warmup' : 'straight',
          sourceSetType: null,
          kg: kg == null || kg === 0 ? null : convert(kg, 'kg', accountUnits),
          reps: reps != null && reps >= 0 && reps <= 200 ? reps : null,
          rpe: rpe != null && rpe >= 1 && rpe <= 10 ? rpe : null,
        });
      }
      if (sets.length) exercises.push({ name, sets });
    }
    if (!exercises.length) continue;
    setCount += exercises.reduce((n, x) => n + x.sets.length, 0);
    workouts.push({
      key: `tracker|${key}`,
      name: log.sessionName?.trim() || 'Workout',
      localDate: log.date,
      // The tracker saves at the end of the workout; it doesn't record a start time.
      startedAt: completedAt - 3_600_000,
      completedAt,
      isDeload: log.phase === 'deload',
      exercises,
    });
  }
  workouts.sort((a, b) => a.startedAt - b.startedAt);
  return { format: 'tracker', source: 'tracker', unit: 'kg', workouts, skipped, errors, setCount };
}
