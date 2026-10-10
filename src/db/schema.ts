import Dexie, { type EntityTable } from 'dexie';
import type { LoadType, Units } from '../engine/types';

/**
 * Local-first store (Dexie / IndexedDB), one database PER ACCOUNT:
 *
 *   retro-tracker:guest      data created before signing in (claimed once on first login)
 *   retro-tracker:<userId>   a signed-in account; another person on the same phone never sees it
 *
 * Synced tables mirror supabase/migrations/0001_init.sql (mapping in src/sync/mapping.ts).
 * Every id is a client-generated UUID (exercises: name-derived uuidv5) so outbox replays
 * are idempotent upserts. `settings` and `timers` are local-only and never queued.
 *
 *   exercises   programmes ─┬─ blocks ── days ── dayExercises
 *                           └─ athleteProgrammes ── sessions ── setLogs        events
 *   nutritionDays   bodyweightLogs   (v3: FUEL)
 *
 * Version history (forward-only: never roll back across a version):
 *   v1 initial · v2 sync (outbox keys, dead letters, programmeId on dayExercises)
 *   v3 FUEL tables + local diagnostics; optional fields on sessions/setLogs. Additive only.
 */

export interface Setting {
  key:
    | 'units'
    | 'soundOn'
    | 'consentAt'
    | 'persistAsked'
    | 'athleteName'
    | 'wakeTipSeen'
    | 'welcomePending'
    | 'earlyDeloadSnoozeUntil'
    | 'theme'
    | 'installDismissed'
    | 'persistGranted'
    | 'persistBannerDismissed'
    | 'deviceId'
    | 'ownerId'
    | 'syncWatermarks'
    | 'restoreDone'
    | 'signInSkipped'
    | 'email'
    | 'proteinTarget'
    | 'importNamespace'
    | 'consentVersion'
    | 'lastBackupAt'
    | 'backupSnoozeUntil'
    | 'plateSetup';
  value: unknown;
}

/** Fields every synced row carries. ownerId is stamped when the row is created signed-in or claimed. */
interface Synced {
  ownerId?: string;
}

export interface Exercise extends Synced {
  id: string;
  name: string;
  loadType: LoadType;
  loadIncrement?: number;
  barWeight?: number;
  swapGroup?: string;
  howTo?: string;
}

export interface Programme extends Synced {
  id: string;
  name: string;
  isTemplate: boolean;
  /** 0 disables scheduled deloads. */
  deloadEvery: number;
  updatedAt: number;
}

/** A run of weeks that repeats the same days (a PHP "phase"). */
export interface ProgrammeBlock extends Synced {
  id: string;
  programmeId: string;
  order: number;
  name: string;
  weeks: number;
}

export interface ProgrammeDay extends Synced {
  id: string;
  programmeId: string;
  blockId: string;
  order: number;
  name: string;
}

export interface DayExercise extends Synced {
  id: string;
  dayId: string;
  programmeId: string;
  order: number;
  exerciseId: string;
  sets: number;
  repMin: number;
  repMax: number;
  targetRpe: number | null;
  /** Bottom of an RPE range, when the programme gives one ("RPE 6–8"). */
  targetRpeMin?: number | null;
  restSec: number;
  /** Weight written into the programme by the coach. */
  prescribedKg: number | null;
  /**
   * prescribed: the programme weight wins (periodised/percentage programmes, e.g. one lifter's waves).
   * auto: the progression engine picks the weight from history.
   */
  progression: 'auto' | 'prescribed';
  warmups: { kg: number | null; reps: number }[];
  cue?: string | null;
  /** Original technique (DROP, AMRAP, SUPERSET…) flattened to straight sets for now. */
  sourceSetType?: string | null;
}

/**
 * The athlete's link to a programme. Position (week/day) is NOT stored: it's derived from
 * completed sessions (engine/schedule.ts derivePosition).
 */
export interface AthleteProgramme extends Synced {
  id: string;
  programmeId: string;
  startedOn: string;
  deloadAnchorWeek: number;
  status: 'active' | 'paused' | 'done';
  deletedAt?: number | null;
  /** 'import' = the container for imported history. Never shown as a programme on TODAY. */
  source?: 'import';
}

export interface PlannedExercise {
  dayExerciseId: string;
  exerciseId: string;
  name: string;
  loadType: LoadType;
  sets: number;
  repMin: number;
  repMax: number;
  targetRpe: number | null;
  targetRpeMin?: number | null;
  restSec: number;
  suggestedKg: number | null;
  repTargets: number[];
  focusSet?: number;
  basedOnWeight?: number | null;
  outcome: string;
  reason: string;
  warmups: { kg: number | null; reps: number }[];
  /** The programme's coaching note for this exercise (shown in the session, collapsible). */
  cue?: string | null;
  /** Special set type from the programme, e.g. "AMRAP last set", "DROP", "SUPERSET" (labels only for now). */
  setTypeLabel?: string | null;
}

export interface Session extends Synced {
  id: string;
  athleteProgrammeId: string;
  dayId: string;
  week: number;
  isDeload: boolean;
  /** Snapshot of the plan when the session started; coach edits never rewrite it. */
  planSnapshot: PlannedExercise[];
  startedAt: number;
  completedAt: number | null;
  /** Decision 1: a live session only opens on the device that started it. */
  deviceId?: string;
  /** Tombstone: discarded sessions are marked, synced, then purged server-side. */
  deletedAt?: number | null;
  /** 'import' = history from another app (Strong). Feeds LAST TIME, PRs and insights, never progression. */
  source?: 'app' | 'import';
  /** Which app imported history came from (missing on early imports = 'strong'). */
  importSource?: 'strong' | 'tracker';
  /** Optional readiness check at session start. Energy is captured, not yet used. */
  sleep?: Sleep | null;
  energy?: Energy | null;
}

export type Sleep = 'rough' | 'ok' | 'great';
export type Energy = 'low' | 'normal' | 'high';

export type SetType = 'warmup' | 'straight';

export interface SetLog extends Synced {
  id: string;
  sessionId: string;
  exerciseId: string;
  dayExerciseId: string;
  setIndex: number;
  setType: SetType;
  plannedKg: number | null;
  plannedReps: number;
  kg: number | null;
  reps: number | null;
  rpe: number | null;
  completed: boolean;
  confirmedAt: number | null;
  deletedAt?: number | null;
  /** Original set type from an import ('failure', 'timed:45', …). Timed sets are excluded from e1RM. */
  sourceSetType?: string | null;
}

/** FUEL: what was eaten on a day. id = the eaten date, YYYY-MM-DD. */
export type ProteinLevel = 'under' | 'hit' | 'over';
export type FoodLevel = 'light' | 'normal' | 'big';

export interface NutritionDay extends Synced {
  id: string;
  /** Grams, when known. Most people guess, so the usual entry is proteinLevel. */
  protein: number | null;
  kcal: number | null;
  /** Guess against the target: under it, hit it, well over it. What the insight buckets on. */
  proteinLevel?: ProteinLevel | null;
  /** Rough size of the day's food. */
  foodLevel?: FoodLevel | null;
  /** Protein target in grams at the time of saving. Null when no target could be worked out. */
  targetG: number | null;
  updatedAt: number;
}

/** Morning bodyweight. id = the measured date, YYYY-MM-DD. */
export interface BodyweightLog extends Synced {
  id: string;
  kg: number;
  updatedAt: number;
}

/** Local-only error and event trail for debugging in guest mode. Never synced. */
export interface Diagnostic {
  id?: number;
  at: number;
  kind: 'write-failed' | 'uncaught' | 'import' | 'restore' | 'upgrade' | 'info';
  message: string;
  version: string;
}

export const SYNCED_TABLES = [
  'exercises',
  'programmes',
  'blocks',
  'days',
  'dayExercises',
  'athleteProgrammes',
  'sessions',
  'setLogs',
  'events',
  'nutritionDays',
  'bodyweightLogs',
] as const;
export type SyncedTable = (typeof SYNCED_TABLES)[number];

export interface OutboxItem {
  id?: number;
  table: SyncedTable;
  rowId: string;
  createdAt: number;
}

/** A row the server rejected as invalid (4xx). Kept for inspection; never retried automatically. */
export interface DeadLetter {
  id?: number;
  table: SyncedTable;
  rowId: string;
  status: number;
  message: string;
  at: number;
}

export interface AppEvent extends Synced {
  id: string;
  name: 'session_started' | 'set_confirmed' | 'set_edited' | 'session_completed' | 'suggestion_reset';
  ts: number;
  payload: Record<string, unknown>;
}

export interface RestTimer {
  key: 'rest';
  endsAt: number;
  totalSec: number;
  sessionId: string;
}

/** Store definitions per version. Exported so the upgrade test can build an older database. */
export const SCHEMA_V1 = {
  settings: 'key',
  exercises: 'id, name',
  programmes: 'id',
  blocks: 'id, programmeId',
  days: 'id, programmeId, blockId',
  dayExercises: 'id, dayId, exerciseId',
  athleteProgrammes: 'id, status',
  sessions: 'id, athleteProgrammeId, completedAt',
  setLogs: 'id, sessionId, exerciseId, [exerciseId+confirmedAt]',
  outbox: '++id, table',
  events: 'id, name, ts',
  timers: 'key',
};
export const SCHEMA_V2 = {
  dayExercises: 'id, dayId, programmeId, exerciseId',
  outbox: '++id, table, [table+rowId]',
  deadLetters: '++id, table',
};
export const SCHEMA_V3 = {
  nutritionDays: 'id',
  bodyweightLogs: 'id',
  diagnostics: '++id, at',
};

export const GUEST = 'guest';
export const dbName = (account: string) => `retro-tracker:${account}`;

export class RetroDB extends Dexie {
  settings!: EntityTable<Setting, 'key'>;
  exercises!: EntityTable<Exercise, 'id'>;
  programmes!: EntityTable<Programme, 'id'>;
  blocks!: EntityTable<ProgrammeBlock, 'id'>;
  days!: EntityTable<ProgrammeDay, 'id'>;
  dayExercises!: EntityTable<DayExercise, 'id'>;
  athleteProgrammes!: EntityTable<AthleteProgramme, 'id'>;
  sessions!: EntityTable<Session, 'id'>;
  setLogs!: EntityTable<SetLog, 'id'>;
  outbox!: EntityTable<OutboxItem, 'id'>;
  deadLetters!: EntityTable<DeadLetter, 'id'>;
  events!: EntityTable<AppEvent, 'id'>;
  timers!: EntityTable<RestTimer, 'key'>;
  nutritionDays!: EntityTable<NutritionDay, 'id'>;
  bodyweightLogs!: EntityTable<BodyweightLog, 'id'>;
  diagnostics!: EntityTable<Diagnostic, 'id'>;

  constructor(name = dbName(GUEST)) {
    super(name);
    this.version(1).stores(SCHEMA_V1);
    this.version(2)
      .stores(SCHEMA_V2)
      .upgrade(async (tx) => {
        // Position is now derived: drop the stored counters.
        await tx
          .table('athleteProgrammes')
          .toCollection()
          .modify((ap: Record<string, unknown>) => {
            delete ap.currentWeek;
            delete ap.nextDayIdx;
            delete ap.doneDayIds;
          });
        // dayExercises gain programmeId (needed to sync programme trees in one query).
        const days = new Map((await tx.table('days').toArray()).map((d: ProgrammeDay) => [d.id, d.programmeId]));
        await tx
          .table('dayExercises')
          .toCollection()
          .modify((de: DayExercise) => {
            de.programmeId = days.get(de.dayId) ?? de.programmeId;
          });
      });
    // v3 is additive: new tables only, no upgrade function, so it can't corrupt existing rows.
    this.version(3).stores(SCHEMA_V3);
  }
}

export const units = (u: unknown): Units => (u === 'lb' ? 'lb' : 'kg');
