import type { SyncedTable } from '../db/schema';

/**
 * Local (Dexie, camelCase, ms timestamps) ↔ server (Postgres, snake_case, ISO timestamps).
 * Explicit per table on purpose: every column the server has is listed once, here.
 * Must match supabase/migrations/0001_init.sql.
 */

export const SERVER_TABLE: Record<SyncedTable, string> = {
  exercises: 'exercises',
  programmes: 'programmes',
  blocks: 'programme_blocks',
  days: 'programme_days',
  dayExercises: 'programme_exercises',
  athleteProgrammes: 'athlete_programmes',
  sessions: 'sessions',
  setLogs: 'set_logs',
  events: 'events',
  nutritionDays: 'nutrition_days',
  bodyweightLogs: 'bodyweight_logs',
};

/** Which server column holds the local ownerId. */
export const OWNER_COLUMN: Record<SyncedTable, string> = {
  exercises: 'owner_id',
  programmes: 'owner_id',
  blocks: 'owner_id',
  days: 'owner_id',
  dayExercises: 'owner_id',
  athleteProgrammes: 'athlete_id',
  sessions: 'athlete_id',
  setLogs: 'athlete_id',
  events: 'user_id',
  nutritionDays: 'athlete_id',
  bodyweightLogs: 'athlete_id',
};

/** Upsert conflict target. Exercises are per-owner (name-derived ids are shared across users). */
export const CONFLICT_KEY: Record<SyncedTable, string> = {
  exercises: 'owner_id,id',
  programmes: 'id',
  blocks: 'id',
  days: 'id',
  dayExercises: 'id',
  athleteProgrammes: 'id',
  sessions: 'id',
  setLogs: 'id',
  events: 'id',
  // One row per athlete per date; the local id IS the date.
  nutritionDays: 'athlete_id,date',
  bodyweightLogs: 'athlete_id,date',
};

/** plain: kept as-is (null stays null) · opt: null on the server = absent locally · time: ms ↔ ISO · date: YYYY-MM-DD */
type Kind = 'plain' | 'opt' | 'time' | 'date';
/** local field → [server column, kind]. Fields not listed stay local-only. */
const COLUMNS: Record<SyncedTable, Record<string, [string, Kind]>> = {
  exercises: {
    id: ['id', 'plain'], name: ['name', 'plain'], loadType: ['load_type', 'plain'], loadIncrement: ['load_increment', 'opt'],
    barWeight: ['bar_weight', 'opt'], swapGroup: ['swap_group', 'opt'], howTo: ['how_to', 'opt'],
  },
  programmes: {
    id: ['id', 'plain'], name: ['name', 'plain'], isTemplate: ['is_template', 'plain'], deloadEvery: ['deload_every', 'plain'],
  },
  blocks: {
    id: ['id', 'plain'], programmeId: ['programme_id', 'plain'], order: ['order', 'plain'], name: ['name', 'plain'], weeks: ['weeks', 'plain'],
  },
  days: {
    id: ['id', 'plain'], programmeId: ['programme_id', 'plain'], blockId: ['block_id', 'plain'], order: ['order', 'plain'], name: ['name', 'plain'],
  },
  dayExercises: {
    id: ['id', 'plain'], dayId: ['day_id', 'plain'], programmeId: ['programme_id', 'plain'], order: ['order', 'plain'],
    exerciseId: ['exercise_id', 'plain'], sets: ['sets', 'plain'], repMin: ['rep_min', 'plain'], repMax: ['rep_max', 'plain'],
    targetRpe: ['target_rpe', 'plain'], targetRpeMin: ['target_rpe_min', 'opt'], restSec: ['rest_sec', 'plain'], prescribedKg: ['prescribed_kg', 'plain'],
    progression: ['progression', 'plain'], warmups: ['warmups', 'plain'], cue: ['cue', 'opt'], sourceSetType: ['source_set_type', 'opt'],
  },
  athleteProgrammes: {
    id: ['id', 'plain'], programmeId: ['programme_id', 'plain'], startedOn: ['started_on', 'date'],
    deloadAnchorWeek: ['deload_anchor_week', 'plain'], status: ['status', 'plain'], deletedAt: ['deleted_at', 'time'],
    source: ['source', 'opt'],
  },
  sessions: {
    id: ['id', 'plain'], athleteProgrammeId: ['athlete_programme_id', 'plain'], dayId: ['day_id', 'plain'], week: ['week', 'plain'],
    isDeload: ['is_deload', 'plain'], planSnapshot: ['plan_snapshot', 'plain'], startedAt: ['started_at', 'time'],
    completedAt: ['completed_at', 'time'], deviceId: ['device_id', 'opt'], deletedAt: ['deleted_at', 'time'],
    source: ['source', 'opt'], importSource: ['import_source', 'opt'], sleep: ['sleep', 'opt'], energy: ['energy', 'opt'],
  },
  setLogs: {
    id: ['id', 'plain'], sessionId: ['session_id', 'plain'], exerciseId: ['exercise_id', 'plain'],
    dayExerciseId: ['programme_exercise_id', 'plain'], setIndex: ['set_index', 'plain'], setType: ['set_type', 'plain'],
    plannedKg: ['planned_kg', 'plain'], plannedReps: ['planned_reps', 'plain'], kg: ['kg', 'plain'], reps: ['reps', 'plain'],
    rpe: ['rpe', 'plain'], completed: ['completed', 'plain'], confirmedAt: ['confirmed_at', 'time'], deletedAt: ['deleted_at', 'time'],
    sourceSetType: ['source_set_type', 'opt'],
  },
  events: {
    id: ['id', 'plain'], name: ['name', 'plain'], ts: ['ts', 'time'], payload: ['payload', 'plain'],
  },
  nutritionDays: {
    id: ['date', 'date'], protein: ['protein', 'plain'], kcal: ['kcal', 'plain'], targetG: ['target_g', 'plain'],
    proteinLevel: ['protein_level', 'opt'], foodLevel: ['food_level', 'opt'],
  },
  bodyweightLogs: {
    id: ['date', 'date'], kg: ['kg', 'plain'],
  },
};

const toIso = (ms: unknown) => (ms == null ? null : new Date(ms as number).toISOString());
const fromIso = (iso: unknown) => (iso == null ? null : Date.parse(iso as string));

export function toServer(table: SyncedTable, row: Record<string, unknown>, userId: string): Record<string, unknown> {
  const out: Record<string, unknown> = { [OWNER_COLUMN[table]]: (row.ownerId as string) ?? userId };
  for (const [local, [col, kind]] of Object.entries(COLUMNS[table])) {
    const v = row[local];
    out[col] = kind === 'time' ? toIso(v) : v === undefined ? null : v;
  }
  return out;
}

export function fromServer(table: SyncedTable, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ownerId: row[OWNER_COLUMN[table]] };
  for (const [local, [col, kind]] of Object.entries(COLUMNS[table])) {
    const v = row[col];
    if (v == null && kind === 'opt') continue;
    out[local] = kind === 'time' ? fromIso(v) : kind === 'date' ? String(v).slice(0, 10) : v;
  }
  if (table === 'programmes' || table === 'nutritionDays' || table === 'bodyweightLogs') out.updatedAt = fromIso(row.updated_at) ?? Date.now();
  return out;
}
