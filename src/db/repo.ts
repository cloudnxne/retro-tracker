import { suggestNext, deloadPrescription } from '../engine/progression';
import { blockForWeek, derivePosition, isDeloadWeek, type Block } from '../engine/schedule';
import { bestE1rm } from '../engine/e1rm';
import { exerciseIdFor } from '../engine/ids';
import { DEFAULT_BAR, PLATES } from '../engine/rounding';
import type { ExerciseSessionResult, LoadType, Units } from '../engine/types';
import { validateProgramme, type ImportedProgramme } from './validate';
import { DEFAULT_G_PER_KG, proteinTargetG } from '../lib/fuelDay';
import {
  RetroDB,
  GUEST,
  SYNCED_TABLES,
  dbName,
  units as toUnits,
  type AppEvent,
  type AthleteProgramme,
  type DayExercise,
  type FoodLevel,
  type ProteinLevel,
  type PlannedExercise,
  type Session,
  type SetLog,
  type Setting,
  type SyncedTable,
} from './schema';

export type { ImportedProgramme } from './validate';
export const uuid = () => crypto.randomUUID();

// ─── Account-scoped database ────────────────────────────────

const ACCOUNT_KEY = 'rt-account';
function readAccount(): string {
  try {
    return localStorage.getItem(ACCOUNT_KEY) || GUEST;
  } catch {
    return GUEST;
  }
}
function writeAccount(account: string) {
  try {
    localStorage.setItem(ACCOUNT_KEY, account);
  } catch {
    /* storage blocked: stays on this account for the page's lifetime */
  }
}

let _account: string | null = null;
let _db: RetroDB | null = null;
export const currentAccount = () => (_account ??= typeof localStorage === 'undefined' ? GUEST : readAccount());
export const db = () => (_db ??= new RetroDB(dbName(currentAccount())));
export const isSignedIn = () => currentAccount() !== GUEST;

/** Tests inject an isolated database. */
export const useTestDb = (d: RetroDB, account = GUEST) => {
  _db = d;
  _account = account;
};

/** Switch the whole app to another account's database (sign in / sign out). */
export function switchAccount(account: string) {
  _db?.close();
  _db = null;
  _account = account;
  writeAccount(account);
}

/**
 * First sign-in on this phone: copy the guest database into the account's database once,
 * stamp ownerId on every synced row and queue it all for upload. The guest DB is then removed.
 * If the account already has data on this phone (signed in before), guest data is left alone.
 */
export async function claimGuestData(userId: string): Promise<{ claimed: number }> {
  const guest = new RetroDB(dbName(GUEST));
  const target = new RetroDB(dbName(userId));
  try {
    const alreadyUsed = (await target.sessions.count()) + (await target.programmes.count()) > 0;
    let claimed = 0;
    if (!alreadyUsed) {
      // Read the guest DB first: a Dexie transaction can't await another database.
      const guestRows = new Map<string, Record<string, unknown>[]>();
      for (const t of SYNCED_TABLES) guestRows.set(t, await guest.table(t).toArray());
      const guestSettings = (await guest.settings.toArray()).filter((s) => s.key !== 'syncWatermarks' && s.key !== 'restoreDone');
      await target.transaction('rw', [...SYNCED_TABLES.map((t) => target.table(t)), target.outbox, target.settings], async () => {
        for (const t of SYNCED_TABLES) {
          const rows: Record<string, unknown>[] = guestRows.get(t)!.map((r) => ({ ...r, ownerId: userId }));
          if (!rows.length) continue;
          await target.table(t).bulkPut(rows);
          await target.outbox.bulkAdd(rows.map((r) => ({ table: t, rowId: String(r.id), createdAt: Date.now() })));
          claimed += rows.length;
        }
        await target.settings.bulkPut(guestSettings);
      });
      guest.close();
      await RetroDB.delete(dbName(GUEST));
    }
    await target.settings.put({ key: 'ownerId', value: userId });
    return { claimed };
  } finally {
    guest.close();
    target.close();
  }
}

/** Before per-account DBs, everything lived in "retro-tracker". Move it into the guest DB once. */
export async function migrateLegacyDb() {
  if (!(await RetroDB.exists('retro-tracker'))) return;
  const legacy = new RetroDB('retro-tracker');
  const guest = new RetroDB(dbName(GUEST));
  try {
    if ((await guest.settings.count()) === 0) {
      for (const t of [...SYNCED_TABLES, 'settings', 'timers'] as const) {
        await guest.table(t).bulkPut(await legacy.table(t).toArray());
      }
    }
  } finally {
    legacy.close();
    guest.close();
  }
  await RetroDB.delete('retro-tracker');
}

// ─── Settings (local-only) ────────────────────────────────────────────────────

export async function getSetting<T>(key: Setting['key'], fallback: T): Promise<T> {
  const row = await db().settings.get(key);
  return (row?.value as T) ?? fallback;
}
export const setSetting = (key: Setting['key'], value: unknown) => db().settings.put({ key, value });
export const getUnits = async (): Promise<Units> => toUnits(await getSetting('units', 'kg'));

/** ME → Plates & bar, per unit system. Defaults: a full plate set and a 20 kg / 45 lb bar. */
export interface PlateSetup {
  plates: number[];
  bar: number;
}
export async function getPlateSetup(units?: Units): Promise<PlateSetup> {
  const u = units ?? (await getUnits());
  const all = await getSetting<Partial<Record<Units, PlateSetup>>>('plateSetup', {});
  return all[u] ?? { plates: PLATES[u], bar: DEFAULT_BAR[u] };
}
export async function setPlateSetup(units: Units, setup: PlateSetup) {
  if (!setup.plates.length) throw new RangeError('Keep at least one plate size');
  const all = await getSetting<Partial<Record<Units, PlateSetup>>>('plateSetup', {});
  await setSetting('plateSetup', { ...all, [units]: { plates: [...setup.plates].sort((a, b) => b - a), bar: setup.bar } });
}

/** A stable id for this phone (a live session only opens where it started). */
export async function deviceId(): Promise<string> {
  const existing = await getSetting<string | null>('deviceId', null);
  if (existing) return existing;
  const id = uuid();
  await setSetting('deviceId', id);
  return id;
}

// ─── Outbox ───────────────────────────────────────────────────────────────────

let onQueued: (() => void) | null = null;
/** The sync runner registers here to schedule a (debounced) sync after local writes. */
export const setQueueListener = (fn: (() => void) | null) => {
  onQueued = fn;
};

/** Queue rows for upload. Every write to a synced table goes through here. */
export async function queue(table: SyncedTable, ...rowIds: string[]) {
  if (!rowIds.length) return;
  const now = Date.now();
  await db().outbox.bulkAdd(rowIds.map((rowId) => ({ table, rowId, createdAt: now })));
  onQueued?.();
}

/** Stamp ownerId on a new row when signed in (guest rows are stamped when claimed). */
export function owned<T extends object>(row: T): T & { ownerId?: string } {
  return isSignedIn() ? { ...row, ownerId: currentAccount() } : row;
}

export async function logEvent(name: AppEvent['name'], payload: Record<string, unknown> = {}) {
  const ev: AppEvent = owned({ id: uuid(), name, ts: Date.now(), payload });
  await db().events.add(ev);
  await queue('events', ev.id);
}

export const live = <T extends { deletedAt?: number | null }>(r: T | undefined): r is T => !!r && !r.deletedAt;

// ─── Programme import (migration JSON or built-in starter) ────────────────────

/** Imports a programme and makes it the athlete's active one. Returns the programme id. */
export async function importProgramme(input: unknown): Promise<string> {
  const p: ImportedProgramme = validateProgramme(input);
  const d = db();
  const programmeId = uuid();
  // Name-derived ids: computed before the transaction (crypto.subtle is async).
  const exIds = new Map<string, string>();
  for (const b of p.blocks) for (const day of b.days) for (const ex of day.exercises) exIds.set(ex.name, await exerciseIdFor(ex.name));

  const tables = [d.exercises, d.programmes, d.blocks, d.days, d.dayExercises, d.athleteProgrammes, d.outbox, d.settings];
  await d.transaction('rw', tables, async () => {
    const queued: Record<SyncedTable, string[]> = Object.fromEntries(SYNCED_TABLES.map((t) => [t, []])) as never;
    await d.programmes.add(owned({ id: programmeId, name: p.name, isTemplate: false, deloadEvery: p.deloadEvery ?? 4, updatedAt: Date.now() }));
    queued.programmes.push(programmeId);
    let blockOrder = 0;
    for (const b of p.blocks) {
      const blockId = uuid();
      await d.blocks.add(owned({ id: blockId, programmeId, order: blockOrder++, name: b.name, weeks: b.weeks }));
      queued.blocks.push(blockId);
      let dayOrder = 0;
      for (const day of b.days) {
        const dayId = uuid();
        await d.days.add(owned({ id: dayId, programmeId, blockId, order: dayOrder++, name: day.name }));
        queued.days.push(dayId);
        let exOrder = 0;
        for (const ex of day.exercises) {
          const exerciseId = exIds.get(ex.name)!;
          const known = await d.exercises.get(exerciseId);
          if (!known) {
            await d.exercises.add(owned({ id: exerciseId, name: ex.name, loadType: ex.loadType, howTo: ex.cue ?? undefined }));
            queued.exercises.push(exerciseId);
          } else if (known.name !== ex.name) {
            // Same exercise (name-derived id), different spelling, e.g. Strong's "pause squat": the
            // programme's spelling is the curated one, so it wins.
            await d.exercises.update(exerciseId, { name: ex.name });
            queued.exercises.push(exerciseId);
          }
          const de: DayExercise = owned({
            id: uuid(),
            dayId,
            programmeId,
            order: exOrder++,
            exerciseId,
            sets: ex.sets,
            repMin: ex.repMin,
            repMax: ex.repMax,
            targetRpe: ex.targetRpe,
            targetRpeMin: ex.targetRpeMin ?? null,
            restSec: ex.restSec,
            prescribedKg: ex.prescribedKg,
            progression: ex.progression ?? (ex.prescribedKg != null ? 'prescribed' : 'auto'),
            warmups: ex.warmups ?? [],
            cue: ex.cue ?? null,
            sourceSetType: ex.sourceSetType ?? null,
          });
          await d.dayExercises.add(de);
          queued.dayExercises.push(de.id);
        }
      }
    }
    for (const ap of await d.athleteProgrammes.where('status').equals('active').toArray()) {
      await d.athleteProgrammes.update(ap.id, { status: 'paused' });
      queued.athleteProgrammes.push(ap.id);
    }
    const apId = uuid();
    await d.athleteProgrammes.add(
      owned({ id: apId, programmeId, startedOn: new Date().toISOString().slice(0, 10), deloadAnchorWeek: 0, status: 'active' as const }),
    );
    queued.athleteProgrammes.push(apId);
    for (const t of SYNCED_TABLES) await queue(t, ...queued[t]);
    if (p.athleteName) {
      await d.settings.put({ key: 'athleteName', value: p.athleteName });
      await d.settings.put({ key: 'welcomePending', value: true });
    }
  });
  return programmeId;
}

// ─── Reading the programme position ───────────────────────────────────────────

/**
 * The programme TODAY shows: the active one, or, when none is active, the most recently
 * finished one (so "Block complete" appears instead of "No programme yet").
 */
export async function activeProgramme(): Promise<AthleteProgramme | undefined> {
  // The imported-history container is never a programme you're running.
  const all = (await db().athleteProgrammes.toArray()).filter((ap) => live(ap) && ap.source !== 'import');
  return (
    all.find((ap) => ap.status === 'active') ??
    all.filter((ap) => ap.status === 'done').sort((a, b) => b.startedOn.localeCompare(a.startedOn))[0]
  );
}

export async function programmeBlocks(programmeId: string): Promise<Block[]> {
  const d = db();
  const blocks = (await d.blocks.where('programmeId').equals(programmeId).toArray()).sort((a, b) => a.order - b.order);
  const days = await d.days.where('programmeId').equals(programmeId).toArray();
  return blocks.map((b) => ({
    id: b.id,
    name: b.name,
    weeks: b.weeks,
    dayIds: days.filter((x) => x.blockId === b.id).sort((x, y) => x.order - y.order).map((x) => x.id),
  }));
}

/** Completed, non-deleted sessions of an athlete programme. */
async function completedSessions(athleteProgrammeId: string) {
  return (await db().sessions.where('athleteProgrammeId').equals(athleteProgrammeId).toArray()).filter(
    (s) => live(s) && s.completedAt != null,
  );
}

/** Week/day are derived from completed sessions, never stored. */
export async function positionOf(ap: AthleteProgramme) {
  const blocks = await programmeBlocks(ap.programmeId);
  return { blocks, pos: derivePosition(blocks, await completedSessions(ap.id)) };
}

export type TodayState =
  | { kind: 'no-programme' }
  | { kind: 'finished'; ap: AthleteProgramme }
  | { kind: 'in-session'; session: Session }
  | {
      kind: 'ready';
      ap: AthleteProgramme;
      dayId: string;
      dayName: string;
      blockName: string;
      week: number;
      isDeload: boolean;
      plan: PlannedExercise[];
      /** Decision 1: a session is live on another device (shown read-only, never opened here). */
      elsewhere: Session | null;
    };

/** A session is open on THIS device (never swap app versions under it). */
export async function hasLiveSessionHere(): Promise<boolean> {
  const me = await getSetting<string | null>('deviceId', null);
  return (await openSessions()).some((s) => !s.deviceId || s.deviceId === me);
}

async function openSessions(): Promise<Session[]> {
  const open = await db().sessions.filter((s) => s.completedAt == null && !s.deletedAt).toArray();
  return open.sort((a, b) => b.startedAt - a.startedAt);
}

export interface LiftSession {
  sessionId: string;
  /** When it was completed (ms). */
  at: number;
  isDeload: boolean;
  source: 'app' | 'import';
  /** The plan for this exercise in that session; null for imported history (no plan exists). */
  prescription: { sets: number; repMin: number; repMax: number; targetRpe: number | null } | null;
  sets: { kg: number | null; reps: number | null; rpe: number | null; completed: boolean }[];
}

/**
 * The ONE reader of "this lift's past sessions". Suggestions, LAST TIME, PRs,
 * PROGRESS and insights all use it, so they can never disagree about what counts.
 * Always excludes: warm-ups, discarded (tombstoned) sets and sessions, unfinished sessions,
 * timed sets (sourceSetType 'timed:…', no reps to compare). Newest first.
 */
export async function liftSessions(
  exerciseId: string,
  { limit = Infinity, includeDeload = true, source = 'all' }: { limit?: number; includeDeload?: boolean; source?: 'all' | 'app' | 'import' } = {},
): Promise<LiftSession[]> {
  const d = db();
  const logs = await d.setLogs.where('exerciseId').equals(exerciseId).toArray();
  const bySession = new Map<string, SetLog[]>();
  for (const l of logs) {
    if (l.setType === 'warmup' || l.deletedAt || l.sourceSetType?.startsWith('timed:')) continue;
    bySession.set(l.sessionId, [...(bySession.get(l.sessionId) ?? []), l]);
  }
  const sessions = (await d.sessions.bulkGet([...bySession.keys()])).filter(
    (s): s is Session =>
      live(s) &&
      s.completedAt != null &&
      (includeDeload || !s.isDeload) &&
      (source === 'all' || (s.source ?? 'app') === source),
  );
  return sessions
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
    .slice(0, limit)
    .map((s) => {
      const snap = s.planSnapshot.find((p) => p.exerciseId === exerciseId);
      const sets = (bySession.get(s.id) ?? []).sort((a, b) => a.setIndex - b.setIndex);
      return {
        sessionId: s.id,
        at: s.completedAt!,
        isDeload: s.isDeload,
        source: s.source ?? 'app',
        prescription: snap ? { sets: snap.sets, repMin: snap.repMin, repMax: snap.repMax, targetRpe: snap.targetRpe } : null,
        sets: sets.map((l) => ({ kg: l.kg, reps: l.reps, rpe: l.rpe, completed: l.completed })),
      };
    });
}

/**
 * History for the progression engine: app-logged sessions only. Imported history has no
 * rep range, and treating it as one would make every imported set look "at the top" (Increase).
 */
export async function exerciseHistory(exerciseId: string, limit = 10): Promise<ExerciseSessionResult[]> {
  return (await liftSessions(exerciseId, { limit, source: 'app' })).map((s) => ({
    isDeload: s.isDeload,
    prescription: s.prescription ?? { sets: s.sets.length, repMin: 1, repMax: 1, targetRpe: null },
    sets: s.sets,
  }));
}

/** Last completed working set for an exercise for an exercise, for the "LAST TIME" hint. */
export async function lastTime(exerciseId: string) {
  // LAST TIME includes imported history: it's what you actually lifted.
  const [h] = await liftSessions(exerciseId, { limit: 1 });
  const done = h?.sets.filter((s) => s.completed) ?? [];
  if (!done.length) return null;
  const top = done.reduce((a, b) => ((b.kg ?? 0) > (a.kg ?? 0) ? b : a));
  return { kg: top.kg, reps: top.reps, rpe: top.rpe };
}

export async function buildPlan(dayId: string, isDeload: boolean, deloadEvery: number): Promise<PlannedExercise[]> {
  const d = db();
  const u = await getUnits();
  const setup = await getPlateSetup(u);
  const des = (await d.dayExercises.where('dayId').equals(dayId).toArray()).sort((a, b) => a.order - b.order);
  const plan: PlannedExercise[] = [];
  for (const de of des) {
    const ex = await d.exercises.get(de.exerciseId);
    if (!ex) continue;
    const rx = { sets: de.sets, repMin: de.repMin, repMax: de.repMax, targetRpe: de.targetRpe };
    // Barbell suggestions only use plates this lifter has, on their bar (exercise bar overrides).
    const load = {
      loadType: ex.loadType,
      loadIncrement: ex.loadIncrement,
      barWeight: ex.loadType === 'plates' ? 0 : (ex.barWeight ?? setup.bar),
      plates: setup.plates,
    };
    const s = suggestNext(await exerciseHistory(ex.id), rx, load, u);
    let weight = s.weight;
    let reason = s.reason;
    let outcome: string = s.outcome;
    if (de.prescribedKg != null && (de.progression === 'prescribed' || s.outcome === 'first-time')) {
      weight = de.prescribedKg;
      outcome = 'programme';
      reason =
        de.progression === 'prescribed'
          ? 'Your programme sets this weight for this block.'
          : 'Weight written into your programme. Auto-progression takes over from next time.';
    }
    // No app-logged history yet but imported history exists → hold at the last imported top
    // working weight instead of asking. Progression proper starts from the first app session.
    if (outcome === 'first-time' && weight == null) {
      const [imp] = await liftSessions(ex.id, { limit: 1, source: 'import', includeDeload: false });
      const top = imp ? Math.max(0, ...imp.sets.filter((x) => x.completed && x.kg != null).map((x) => x.kg!)) : 0;
      if (top > 0) {
        weight = top;
        outcome = 'imported';
        reason = 'From your imported history: your last top working set. Hold it, then the app takes over progression.';
      }
    }
    let sets = de.sets;
    if (isDeload && deloadEvery > 0) {
      const dl = deloadPrescription(s.basedOnWeight ?? weight, rx, load, u);
      weight = dl.weight;
      sets = dl.sets;
      outcome = 'deload';
      reason = 'Deload week: 60% and one set fewer. Should feel easy. That is the point.';
    }
    plan.push({
      dayExerciseId: de.id,
      exerciseId: ex.id,
      name: ex.name,
      loadType: ex.loadType,
      sets,
      repMin: de.repMin,
      repMax: de.repMax,
      targetRpe: de.targetRpe,
      targetRpeMin: de.targetRpeMin ?? null,
      cue: de.cue ?? ex.howTo ?? null,
      setTypeLabel: de.sourceSetType ?? null,
      restSec: de.restSec,
      suggestedKg: weight,
      repTargets: Array.from({ length: sets }, (_, i) => s.repTargets[i] ?? de.repMin),
      focusSet: s.focusSet,
      basedOnWeight: s.basedOnWeight,
      outcome,
      reason,
      warmups: isDeload ? [] : de.warmups,
    });
  }
  return plan;
}

export async function today(): Promise<TodayState> {
  const me = await getSetting<string | null>('deviceId', null);
  const open = await openSessions();
  // Sessions from before deviceIds existed count as "this device".
  const mine = open.find((s) => !s.deviceId || s.deviceId === me);
  if (mine) return { kind: 'in-session', session: mine };
  const ap = await activeProgramme();
  if (!ap) return { kind: 'no-programme' };
  const programme = await db().programmes.get(ap.programmeId);
  const { blocks, pos } = await positionOf(ap);
  const where = blockForWeek(blocks, pos.week);
  if (pos.finished || !where || ap.status === 'done') return { kind: 'finished', ap };
  const dayId = where.block.dayIds[pos.dayIdx];
  const day = await db().days.get(dayId);
  const isDeload = isDeloadWeek(pos.week, ap.deloadAnchorWeek, programme?.deloadEvery ?? 4);
  return {
    kind: 'ready',
    ap,
    dayId,
    dayName: day?.name ?? 'Session',
    blockName: where.block.name,
    week: pos.week,
    isDeload,
    plan: await buildPlan(dayId, isDeload, programme?.deloadEvery ?? 4),
    elsewhere: open.find((s) => s.athleteProgrammeId === ap.id) ?? null,
  };
}

// ─── Programme actions ────────────────────────────────────────────────────────

/** Early deload accepted: make the current week a deload and restart the 4-week counter. */
export async function takeEarlyDeload(ap: AthleteProgramme, week: number) {
  const programme = await db().programmes.get(ap.programmeId);
  const every = programme?.deloadEvery || 4;
  await db().athleteProgrammes.update(ap.id, { deloadAnchorWeek: week - every });
  await queue('athleteProgrammes', ap.id);
}

/**
 * "Run it again": start a fresh athlete programme on the same programme. History stays with the
 * finished one (position is derived from each athlete programme's own sessions).
 */
export async function restartProgramme(ap: AthleteProgramme) {
  const d = db();
  const fresh = owned({ id: uuid(), programmeId: ap.programmeId, startedOn: new Date().toISOString().slice(0, 10), deloadAnchorWeek: 0, status: 'active' as const });
  await d.transaction('rw', [d.athleteProgrammes, d.outbox], async () => {
    await d.athleteProgrammes.update(ap.id, { status: 'done' });
    await d.athleteProgrammes.add(fresh);
    await queue('athleteProgrammes', ap.id, fresh.id);
  });
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

export async function startSession(state: Extract<TodayState, { kind: 'ready' }>): Promise<Session> {
  const d = db();
  const session: Session = owned({
    id: uuid(),
    athleteProgrammeId: state.ap.id,
    dayId: state.dayId,
    week: state.week,
    isDeload: state.isDeload,
    planSnapshot: state.plan,
    startedAt: Date.now(),
    completedAt: null,
    deviceId: await deviceId(),
  });
  const logs: SetLog[] = [];
  for (const p of state.plan) {
    p.warmups.forEach((w, i) =>
      logs.push(
        owned({
          id: uuid(), sessionId: session.id, exerciseId: p.exerciseId, dayExerciseId: p.dayExerciseId,
          setIndex: i, setType: 'warmup' as const, plannedKg: w.kg, plannedReps: w.reps, kg: w.kg, reps: w.reps,
          rpe: null, completed: false, confirmedAt: null,
        }),
      ),
    );
    for (let i = 0; i < p.sets; i++) {
      logs.push(
        owned({
          id: uuid(), sessionId: session.id, exerciseId: p.exerciseId, dayExerciseId: p.dayExerciseId,
          setIndex: p.warmups.length + i, setType: 'straight' as const, plannedKg: p.suggestedKg,
          plannedReps: p.repTargets[i], kg: p.suggestedKg, reps: p.repTargets[i], rpe: null,
          completed: false, confirmedAt: null,
        }),
      );
    }
  }
  await d.transaction('rw', [d.sessions, d.setLogs, d.outbox, d.events], async () => {
    await d.sessions.add(session);
    await d.setLogs.bulkAdd(logs);
    await queue('sessions', session.id);
    await queue('setLogs', ...logs.map((l) => l.id)); // every set log syncs, not just touched ones
    await logEvent('session_started', { sessionId: session.id, dayId: state.dayId });
    for (const p of state.plan) {
      if (p.outcome === 'reset') await logEvent('suggestion_reset', { exerciseId: p.exerciseId });
    }
  });
  return session;
}

export async function sessionSets(sessionId: string): Promise<SetLog[]> {
  return (await db().setLogs.where('sessionId').equals(sessionId).toArray()).filter((l) => !l.deletedAt);
}

/** Confirm a set. `restEndedAt` feeds the "time to confirm" metric. */
export async function confirmSet(log: SetLog, restEndedAt: number | null) {
  const d = db();
  const asPrescribed = log.kg === log.plannedKg && log.reps === log.plannedReps;
  await d.transaction('rw', [d.setLogs, d.outbox, d.events], async () => {
    await d.setLogs.update(log.id, { completed: true, confirmedAt: Date.now() });
    await queue('setLogs', log.id);
    await logEvent('set_confirmed', {
      setLogId: log.id,
      as_prescribed: asPrescribed,
      ms_since_rest_end: restEndedAt ? Date.now() - restEndedAt : null,
    });
  });
}

export async function undoSet(logId: string) {
  await db().setLogs.update(logId, { completed: false, confirmedAt: null });
  await queue('setLogs', logId);
}

/**
 * Edit weight/reps/RPE. Weight edits on an unconfirmed set carry forward to the later
 * unconfirmed working sets of the same exercise. Confirmed sets never change.
 */
export async function editSet(log: SetLog, patch: Partial<Pick<SetLog, 'kg' | 'reps' | 'rpe'>>) {
  const d = db();
  await d.transaction('rw', [d.setLogs, d.outbox, d.events], async () => {
    await d.setLogs.update(log.id, patch);
    await queue('setLogs', log.id);
    if (patch.kg !== undefined && !log.completed && log.setType === 'straight') {
      const later = (await d.setLogs.where('sessionId').equals(log.sessionId).toArray()).filter(
        (l) => l.dayExerciseId === log.dayExerciseId && l.setType === 'straight' && !l.completed && l.setIndex > log.setIndex,
      );
      for (const l of later) await d.setLogs.update(l.id, { kg: patch.kg });
      await queue('setLogs', ...later.map((l) => l.id));
    }
    await logEvent('set_edited', { setLogId: log.id, fields: Object.keys(patch) });
  });
}

export interface SessionSummary {
  durationMs: number;
  setsLogged: number;
  volumeKg: number;
  progressed: number;
  prs: { name: string; e1rm: number; delta: number | null }[];
  skipped: number;
}

/**
 * Finish a session. Owns every "session ended" side effect, including stopping
 * the rest timer, so no caller has to remember it.
 * @param completedAt override for stale sessions: use the last logged set's time, not now.
 */
export async function finishSession(sessionId: string, completedAt = Date.now()): Promise<SessionSummary> {
  const d = db();
  const session = await d.sessions.get(sessionId);
  if (!session) throw new Error('Session not found');
  const logs = await sessionSets(sessionId);

  // PRs: best e1RM this session vs all previous completed sessions of that exercise.
  const prs: SessionSummary['prs'] = [];
  for (const p of session.planSnapshot) {
    const mine = logs.filter((l) => l.exerciseId === p.exerciseId && l.setType === 'straight' && !l.sourceSetType?.startsWith('timed:'));
    const best = bestE1rm(mine);
    if (!best) continue;
    // Every earlier session, imported history included: a PR is a PR against everything you've lifted.
    const history = await liftSessions(p.exerciseId);
    const prev = Math.max(0, ...history.map((h) => bestE1rm(h.sets) ?? 0));
    if (history.length && best > prev) prs.push({ name: p.name, e1rm: best, delta: Math.round((best - prev) * 10) / 10 });
  }

  const ap = await d.athleteProgrammes.get(session.athleteProgrammeId);
  await d.transaction('rw', [d.sessions, d.setLogs, d.athleteProgrammes, d.blocks, d.days, d.outbox, d.events, d.timers], async () => {
    await d.sessions.update(sessionId, { completedAt });
    await queue('sessions', sessionId);
    await d.timers.delete('rest');
    if (ap) {
      const { pos } = await positionOf(ap);
      if (pos.finished && ap.status !== 'done') {
        await d.athleteProgrammes.update(ap.id, { status: 'done' });
        await queue('athleteProgrammes', ap.id);
      }
    }
    await logEvent('session_completed', { sessionId });
  });

  const working = logs.filter((l) => l.setType === 'straight');
  return {
    durationMs: completedAt - session.startedAt,
    setsLogged: working.filter((l) => l.completed).length,
    volumeKg: Math.round(working.filter((l) => l.completed).reduce((v, l) => v + (l.kg ?? 0) * (l.reps ?? 0), 0)),
    progressed: session.planSnapshot.filter((p) => p.outcome === 'increase').length,
    prs,
    skipped: working.filter((l) => !l.completed).length,
  };
}

/** A session left open longer than this asks "Finish or discard?" on reopen. */
export const STALE_SESSION_MS = 6 * 3_600_000;

/**
 * Discard a session: tombstone it and its sets so the delete reaches the server
 * and every other device; the server purges tombstones after 30 days. Stops the rest timer.
 */
export async function discardSession(sessionId: string) {
  const d = db();
  const now = Date.now();
  await d.transaction('rw', [d.sessions, d.setLogs, d.outbox, d.timers], async () => {
    const logs = await d.setLogs.where('sessionId').equals(sessionId).toArray();
    await d.setLogs.bulkUpdate(logs.map((l) => ({ key: l.id, changes: { deletedAt: now } })));
    await d.sessions.update(sessionId, { deletedAt: now });
    await queue('sessions', sessionId);
    await queue('setLogs', ...logs.map((l) => l.id));
    await d.timers.delete('rest');
  });
}

export const pendingSyncCount = () => db().outbox.count();

/** ME → export all my data (privacy: users can take all their data). */
/** Marks a JSON file as a Retro Tracker backup; `version` is the database version that wrote it. */
export const BACKUP_FORMAT = 'retro-tracker-backup';

export async function exportAll() {
  const d = db();
  const out: Record<string, unknown> = { format: BACKUP_FORMAT, version: d.verno, exportedAt: new Date().toISOString() };
  for (const t of ['settings', ...SYNCED_TABLES] as const) out[t] = await d.table(t).toArray();
  return out;
}

/**
 * One row per logged set, for Sheets/Excel.
 * Columns: date, exercise, set (W for warm-ups), kg, reps, rpe, warmup.
 */
export async function exportSetsCsv(): Promise<string> {
  const d = db();
  const sessions = new Map((await d.sessions.toArray()).filter((s) => live(s)).map((s) => [s.id, s]));
  const names = new Map((await d.exercises.toArray()).map((e) => [e.id, e.name]));
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Order: session date, then exercise order in that session's plan, then set order.
  const order = (l: SetLog) => {
    const s = sessions.get(l.sessionId)!;
    return [s.completedAt ?? s.startedAt, s.planSnapshot.findIndex((p) => p.dayExerciseId === l.dayExerciseId), l.setIndex];
  };
  const rows = (await d.setLogs.toArray())
    .filter((l) => l.completed && !l.deletedAt && sessions.get(l.sessionId)?.completedAt)
    .sort((a, b) => {
      const [x, y] = [order(a), order(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
  const setNo = new Map<string, number>();
  const lines = rows.map((l) => {
    const s = sessions.get(l.sessionId)!;
    const key = `${l.sessionId}:${l.dayExerciseId}`;
    const n = l.setType === 'warmup' ? 'W' : String((setNo.get(key) ?? 0) + 1);
    if (l.setType !== 'warmup') setNo.set(key, Number(n));
    const date = new Date(s.completedAt ?? s.startedAt).toISOString().slice(0, 10);
    return [date, names.get(l.exerciseId) ?? l.exerciseId, n, l.kg, l.reps, l.rpe, l.setType === 'warmup'].map(esc).join(',');
  });
  return ['date,exercise,set,kg,reps,rpe,warmup', ...lines].join('\n');
}

export async function completedSessionCount() {
  return db().sessions.filter((s) => s.completedAt != null && !s.deletedAt).count();
}

/** Wipes this account's local database. Cloud deletion happens first, in src/sync. */
export async function deleteLocalData() {
  const name = dbName(currentAccount());
  _db?.close();
  _db = null;
  await RetroDB.delete(name);
}

// ─── FUEL ─────────────────────────────────────────────────────────────

/** Latest bodyweight logged on or before `date` (YYYY-MM-DD), in the account's units. */
export async function bodyweightOn(date: string): Promise<number | null> {
  const rows = await db().bodyweightLogs.where('id').belowOrEqual(date).reverse().limit(1).toArray();
  return rows[0]?.kg ?? null;
}

/** g/kg setting (default 1.6) and the gram target it gives on `date`. */
export async function proteinTargetOn(date: string): Promise<{ gPerKg: number; grams: number | null }> {
  const gPerKg = await getSetting<number>('proteinTarget', DEFAULT_G_PER_KG);
  return { gPerKg, grams: proteinTargetG(gPerKg, await bodyweightOn(date), await getUnits()) };
}

/**
 * Save one day's food guess. The target in force is SNAPSHOTTED onto the row: changing the
 * setting later never rewrites what "hit target" meant on a past day.
 */
export async function saveFuel(date: string, patch: { proteinLevel?: ProteinLevel | null; foodLevel?: FoodLevel | null }) {
  const d = db();
  const { grams } = await proteinTargetOn(date);
  await d.transaction('rw', [d.nutritionDays, d.outbox], async () => {
    const prev = await d.nutritionDays.get(date);
    await d.nutritionDays.put(
      owned({
        id: date,
        protein: prev?.protein ?? null,
        kcal: prev?.kcal ?? null,
        proteinLevel: prev?.proteinLevel ?? null,
        foodLevel: prev?.foodLevel ?? null,
        ...patch,
        targetG: grams,
        updatedAt: Date.now(),
      }),
    );
    await queue('nutritionDays', date);
  });
}

export async function saveBodyweight(date: string, kg: number) {
  // In the account's units (kg or lb), so the ceiling covers a heavy lifter in lb.
  if (!(kg >= 20 && kg <= 900)) throw new RangeError(`Bodyweight ${kg} is out of range`);
  const d = db();
  await d.transaction('rw', [d.bodyweightLogs, d.outbox], async () => {
    await d.bodyweightLogs.put(owned({ id: date, kg: Math.round(kg * 10) / 10, updatedAt: Date.now() }));
    await queue('bodyweightLogs', date);
  });
}

/** Session menu → Equipment: e.g. mark Leg Press as plate-loaded. Applies everywhere from now on. */
export async function setExerciseLoadType(exerciseId: string, loadType: LoadType) {
  const d = db();
  await d.transaction('rw', [d.exercises, d.outbox], async () => {
    if (!(await d.exercises.update(exerciseId, { loadType }))) throw new Error('Exercise not found');
    await queue('exercises', exerciseId);
  });
}

export async function fuelOn(date: string) {
  const d = db();
  return { food: (await d.nutritionDays.get(date)) ?? null, bodyweight: (await d.bodyweightLogs.get(date))?.kg ?? null };
}
