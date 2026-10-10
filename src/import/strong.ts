import type { LoadType, Units } from '../engine/types';

/**
 * Strong CSV → an app-neutral import model. Format verified against a real 7-year export
 *: 13 quoted columns, Date "YYYY-MM-DD HH:MM:SS" (local time), the unit
 * in the weight header, Set Order = number | W | F | D | "Rest Timer" | "Note".
 */

export type ImportFormat = 'strong' | 'tracker' | 'hevy' | 'unknown';
/** Where imported history came from. On the same day, a higher-priority source wins. */
export type ImportSource = 'strong' | 'tracker';
export const SOURCE_PRIORITY: Record<ImportSource, number> = { strong: 1, tracker: 2 };
export const SOURCE_LABEL: Record<ImportSource, string> = { strong: 'Strong', tracker: 'tracker log' };

export interface ImportSet {
  setType: 'warmup' | 'straight';
  /** Original type when it wasn't a plain working set: 'failure', 'drop', 'timed:45'. */
  sourceSetType: string | null;
  kg: number | null;
  reps: number | null;
  rpe: number | null;
}

export interface ImportExercise {
  name: string;
  sets: ImportSet[];
}

export interface ImportWorkout {
  /** The export's own timestamp text: the stable identity of this workout across re-imports. */
  key: string;
  name: string;
  /** Local calendar day, YYYY-MM-DD: how workouts from different sources are matched. */
  localDate: string;
  startedAt: number;
  completedAt: number;
  isDeload?: boolean;
  exercises: ImportExercise[];
}

export interface RowError {
  /** Spreadsheet row number (the header is row 1). Notes with line breaks don't shift it. */
  row: number;
  message: string;
}

export interface ParsedImport {
  format: ImportFormat;
  source: ImportSource;
  unit: Units;
  workouts: ImportWorkout[];
  /** Counted, never imported: rest timers, notes, cardio. */
  skipped: {
    restTimers: number;
    notes: number;
    cardio: number;
    /** Tracker logs: unticked sets left exactly as prefilled (never done). */
    untickedUnchanged?: number;
    /** Tracker logs: the same workout saved more than once (the latest save is kept). */
    duplicateSaves?: number;
    /** Programme template files picked by mistake. */
    templates?: number;
  };
  errors: RowError[];
  /** Rows that are real sets but failed validation (imported only if the user ticks "import the rest"). */
  setCount: number;
}

export function detectFormat(header: string[]): ImportFormat {
  const h = new Set(header.map((x) => x.trim()));
  if (h.has('Workout #') && h.has('Exercise Name') && h.has('Set Order')) return 'strong';
  if (h.has('exercise_title') && h.has('set_type')) return 'hevy';
  return 'unknown';
}

const DATE = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)$/;
/** Local wall-clock time, as Strong writes it (no timezone in the file). */
export function parseLocalDate(s: string): number | null {
  const m = DATE.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  const dt = new Date(y, mo - 1, d, h, mi, se);
  // Date() silently rolls "2024-13-40" into 2025: reject anything that doesn't round-trip.
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d || dt.getHours() !== h || dt.getMinutes() !== mi) return null;
  return dt.getTime();
}

const num = (s: string | undefined): number | null | 'bad' => {
  const v = (s ?? '').trim();
  if (v === '') return null;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : 'bad';
};

const LB_PER_KG = 2.2046226218;
export const convert = (w: number, from: Units, to: Units) =>
  from === to ? w : Math.round((from === 'kg' ? w * LB_PER_KG : w / LB_PER_KG) * 10) / 10;

/**
 * Turns parsed CSV rows (header first) into workouts. Never throws on bad rows: each one becomes a
 * named RowError and is left out, so the preview can show exactly what would be skipped.
 */
export function parseStrong(rows: string[][], accountUnits: Units): ParsedImport {
  const [header, ...body] = rows;
  const col = new Map(header.map((h, i) => [h.trim(), i]));
  const weightHeader = header.find((h) => /^Weight \((kg|lbs?)\)$/i.test(h.trim()))?.trim();
  const fileUnit: Units = weightHeader && /lb/i.test(weightHeader) ? 'lb' : 'kg';
  const get = (r: string[], name: string) => r[col.get(name) ?? -1] ?? '';

  const skipped = { restTimers: 0, notes: 0, cardio: 0 };
  const errors: RowError[] = [];
  const byKey = new Map<string, ImportWorkout>();
  let setCount = 0;

  body.forEach((r, idx) => {
    const row = idx + 2;
    if (r.length < header.length) return void errors.push({ row, message: `has ${r.length} columns, expected ${header.length}` });
    const order = get(r, 'Set Order').trim();
    if (order === 'Rest Timer') return void skipped.restTimers++;
    if (order === 'Note') return void skipped.notes++;
    const distance = num(get(r, 'Distance (meters)')) ?? num(get(r, 'Distance (km)')) ?? num(get(r, 'Distance (miles)'));
    if (typeof distance === 'number' && distance > 0) return void skipped.cardio++;

    const dateText = get(r, 'Date').trim();
    const startedAt = parseLocalDate(dateText);
    if (startedAt == null) return void errors.push({ row, message: `date "${dateText}" not recognised` });
    const name = get(r, 'Exercise Name').trim();
    if (!name) return void errors.push({ row, message: 'exercise name is empty' });

    let setType: ImportSet['setType'] = 'straight';
    let sourceSetType: string | null = null;
    if (order === 'W') setType = 'warmup';
    else if (order === 'F') sourceSetType = 'failure';
    else if (order === 'D') sourceSetType = 'drop';
    else if (!/^\d+$/.test(order)) return void errors.push({ row, message: `set type "${order}" not recognised` });

    const kg = num(weightHeader ? get(r, weightHeader) : '');
    const reps = num(get(r, 'Reps'));
    const rpe = num(get(r, 'RPE'));
    const seconds = num(get(r, 'Seconds'));
    if (kg === 'bad' || reps === 'bad' || rpe === 'bad' || seconds === 'bad') {
      return void errors.push({ row, message: 'weight, reps, RPE or seconds is not a number' });
    }
    if (kg != null && (kg < 0 || kg > 1000)) return void errors.push({ row, message: `weight ${kg} is out of range` });
    if (reps != null && (reps < 0 || reps > 200)) return void errors.push({ row, message: `reps ${reps} is out of range` });
    const timed = typeof seconds === 'number' && seconds > 0 && !reps;
    if (timed) sourceSetType = `timed:${seconds}`;

    let w = byKey.get(dateText);
    if (!w) {
      const duration = num(get(r, 'Duration (sec)'));
      const durationMs = typeof duration === 'number' && duration > 0 ? duration * 1000 : 3_600_000;
      w = {
        key: dateText,
        name: get(r, 'Workout Name').trim() || 'Workout',
        localDate: dateText.slice(0, 10),
        startedAt,
        completedAt: startedAt + durationMs,
        exercises: [],
      };
      byKey.set(dateText, w);
    }
    let ex = w.exercises.find((e) => e.name === name);
    if (!ex) w.exercises.push((ex = { name, sets: [] }));
    ex.sets.push({
      setType,
      sourceSetType,
      // Strong writes 0 for bodyweight and timed sets: no load, not "0 kg".
      kg: kg == null || kg === 0 ? null : convert(kg, fileUnit, accountUnits),
      reps: timed ? null : reps,
      rpe: rpe != null && rpe >= 1 && rpe <= 10 ? rpe : null,
    });
    setCount++;
  });

  const workouts = [...byKey.values()].sort((a, b) => a.startedAt - b.startedAt);
  return { format: 'strong', source: 'strong', unit: fileUnit, workouts, skipped, errors, setCount };
}

/**
 * Load type from Strong's equipment suffix, e.g. "Squat (Barbell)". `certain` is false when the
 * name has no recognised suffix: those go to the review list in the preview.
 */
export function guessLoadType(name: string, everyWeightEmpty: boolean): { loadType: LoadType; certain: boolean } {
  const suffix = /\(([^)]+)\)\s*$/.exec(name)?.[1].toLowerCase() ?? '';
  if (/barbell|ez bar|trap bar/.test(suffix)) return { loadType: 'barbell', certain: true };
  if (/dumbbell|kettlebell/.test(suffix)) return { loadType: 'dumbbell', certain: true };
  if (/plate loaded|plate-loaded/.test(suffix)) return { loadType: 'plates', certain: true };
  if (/machine|cable|smith|band|plate/.test(suffix)) return { loadType: 'machine', certain: true };
  if (/bodyweight|assisted|weighted/.test(suffix)) return { loadType: 'bodyweight', certain: true };
  if (everyWeightEmpty) return { loadType: 'bodyweight', certain: true };
  // Usually plate-loaded, but gyms differ: a guess for the review list, not a certainty.
  if (/leg press|hack squat|t-?bar|pendulum|belt squat/i.test(name)) return { loadType: 'plates', certain: false };
  return { loadType: 'barbell', certain: false };
}
