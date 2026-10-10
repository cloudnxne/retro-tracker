import { exerciseIdFor, uuidv5 } from '../engine/ids';
import type { LoadType } from '../engine/types';
import { guessLoadType, SOURCE_PRIORITY, type ImportSource, type ImportWorkout, type ParsedImport } from '../import/strong';
import { db, getSetting, live, owned, queue, uuid } from './repo';
import type { AthleteProgramme, Exercise, Session, SetLog, SyncedTable } from './schema';

/**
 * History import.
 *
 *   file ─▶ parse (src/import) ─▶ previewImport() ─▶ user confirms ─▶ commitImport(): ONE transaction
 *
 * - Every id is uuidv5(importNamespace, …): re-importing the same file gives the same ids, and two
 *   accounts can never collide on the server.
 * - Imported sessions carry source 'import' under one "Imported history" athlete programme. They
 *   feed LAST TIME, PRs and insights, never the progression rules.
 * - Re-import replaces each workout wholesale: sets that vanished from the file are tombstoned.
 * - Any failure inside the transaction writes nothing at all.
 */

/** An imported workout within this window of an app-logged session on the same day is skipped. */
export const OVERLAP_MS = 2 * 3_600_000;

export interface ImportExerciseRow {
  name: string;
  id: string;
  /** Already in this app (from a programme or an earlier import): its load type is kept. */
  existing: boolean;
  loadType: LoadType;
  /** False when the name has no equipment suffix: shown in the review list. */
  certain: boolean;
}

export interface ImportPreview {
  parsed: ParsedImport;
  namespace: string;
  /** Workouts that will be written (overlaps removed). */
  workouts: ImportWorkout[];
  sets: number;
  overlaps: { name: string; at: number }[];
  /** Previously imported workouts FROM THIS SOURCE that are no longer in this file (keep or remove). */
  missing: { sessionId: string; at: number }[];
  /** Workouts skipped because a higher-priority source already has that day (tracker beats Strong). */
  covered: { name: string; at: number; by: ImportSource }[];
  /** Lower-priority imported workouts on the same days that this import replaces. */
  replaces: { sessionId: string; at: number; from: ImportSource }[];
  /** How many of the workouts were already imported before (a re-import). */
  alreadyImported: number;
  exercises: ImportExerciseRow[];
  range: { from: number; to: number } | null;
}

async function importNamespace(): Promise<string> {
  return (await getSetting<string | null>('importNamespace', null)) ?? uuid();
}

const dayOf = (ms: number) => new Date(ms).toDateString();
/** Local YYYY-MM-DD, the key used to match the same workout across sources. */
const localDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const sourceOf = (s: Session): ImportSource => s.importSource ?? 'strong';
const sessionIdFor = (w: ImportWorkout, ns: string) => uuidv5(`import|session|${w.key}`, ns);

export async function previewImport(parsed: ParsedImport): Promise<ImportPreview> {
  const d = db();
  const namespace = await importNamespace();

  const all = (await d.sessions.toArray()).filter((s) => live(s));
  const appSessions = all.filter((s) => (s.source ?? 'app') === 'app');
  const imported = all.filter((s) => s.source === 'import');
  const mine = parsed.source;
  const myRank = SOURCE_PRIORITY[mine];
  // Days already held by a higher-priority source, and lower-priority workouts this import replaces.
  const strongerDays = new Map<string, ImportSource>();
  for (const s of imported) if (SOURCE_PRIORITY[sourceOf(s)] > myRank) strongerDays.set(localDate(s.startedAt), sourceOf(s));

  const overlaps: ImportPreview['overlaps'] = [];
  const covered: ImportPreview['covered'] = [];
  const workouts = parsed.workouts.filter((w) => {
    const by = strongerDays.get(w.localDate);
    if (by) {
      covered.push({ name: w.name, at: w.startedAt, by });
      return false;
    }
    const clash = appSessions.some((s) => dayOf(s.startedAt) === dayOf(w.startedAt) && Math.abs(s.startedAt - w.startedAt) <= OVERLAP_MS);
    if (clash) overlaps.push({ name: w.name, at: w.startedAt });
    return !clash;
  });
  const myDays = new Set(workouts.map((w) => w.localDate));
  const replaces = imported
    .filter((s) => SOURCE_PRIORITY[sourceOf(s)] < myRank && myDays.has(localDate(s.startedAt)))
    .map((s) => ({ sessionId: s.id, at: s.startedAt, from: sourceOf(s) }));

  const newIds = new Set(await Promise.all(workouts.map((w) => sessionIdFor(w, namespace))));
  // Only this source's earlier imports can be "missing": a tracker import must never flag Strong history.
  const previous = imported.filter((s) => sourceOf(s) === mine);
  const missing = previous.filter((s) => !newIds.has(s.id)).map((s) => ({ sessionId: s.id, at: s.startedAt }));
  const alreadyImported = previous.filter((s) => newIds.has(s.id)).length;

  const byName = new Map<string, boolean>(); // name → every set has no weight
  for (const w of workouts) for (const e of w.exercises) byName.set(e.name, (byName.get(e.name) ?? true) && e.sets.every((s) => s.kg == null));
  const exercises: ImportExerciseRow[] = [];
  for (const [name, empty] of byName) {
    const id = await exerciseIdFor(name);
    const known = await d.exercises.get(id);
    const g = guessLoadType(name, empty);
    exercises.push({ name, id, existing: !!known, loadType: known?.loadType ?? g.loadType, certain: !!known || g.certain });
  }
  exercises.sort((a, b) => Number(a.certain) - Number(b.certain) || a.name.localeCompare(b.name));

  const sets = workouts.reduce((n, w) => n + w.exercises.reduce((m, e) => m + e.sets.length, 0), 0);
  const range = workouts.length ? { from: workouts[0].startedAt, to: workouts[workouts.length - 1].startedAt } : null;
  return { parsed, namespace, workouts, sets, overlaps, covered, replaces, missing, alreadyImported, exercises, range };
}

export interface ImportResult {
  workouts: number;
  sets: number;
  /** Workouts removed: missing from the file (when asked) plus lower-priority ones replaced. */
  removed: number;
  /** Rows actually written (new or changed). A re-import of an unchanged file writes 0. */
  written: number;
}

/** Same content as what's stored (ignoring ownerId, which claim may have stamped later). */
const SESSION_FIELDS = ['athleteProgrammeId', 'startedAt', 'completedAt', 'source', 'importSource', 'isDeload'] as const;
const SET_FIELDS = ['sessionId', 'exerciseId', 'setIndex', 'setType', 'kg', 'reps', 'rpe', 'completed', 'sourceSetType'] as const;
function unchanged<T extends object>(stored: T | undefined, next: T, fields: readonly (keyof T)[]): boolean {
  if (!stored || (stored as { deletedAt?: number | null }).deletedAt) return false;
  return fields.every((k) => (stored[k] ?? null) === (next[k] ?? null));
}

/**
 * Writes the preview in one transaction. `loadTypes` overrides the guess for new exercises (the
 * review list); `removeMissing` tombstones previously imported workouts that left the file.
 * Throws on failure, and then nothing has been written.
 */
export async function commitImport(
  p: ImportPreview,
  { loadTypes = {}, removeMissing = false }: { loadTypes?: Record<string, LoadType>; removeMissing?: boolean } = {},
): Promise<ImportResult> {
  const d = db();
  const ns = p.namespace;
  const now = Date.now();

  // Every id is computed BEFORE the transaction: awaiting crypto.subtle inside a Dexie
  // transaction would let it auto-commit half-way.
  const apId = await uuidv5('import|athlete-programme', ns);
  const programmeId = await uuidv5('import|programme', ns);
  const dayId = await uuidv5('import|day', ns);
  const dayExerciseId = await uuidv5('import|day-exercise', ns);
  const exIds = new Map(p.exercises.map((e) => [e.name, e.id]));

  const sessions: Session[] = [];
  const logs: SetLog[] = [];
  for (const w of p.workouts) {
    const sessionId = await sessionIdFor(w, ns);
    sessions.push(
      owned({
        id: sessionId, athleteProgrammeId: apId, dayId, week: 0, isDeload: !!w.isDeload, planSnapshot: [],
        startedAt: w.startedAt, completedAt: w.completedAt, source: 'import' as const, importSource: p.parsed.source,
      }),
    );
    let setIndex = 0;
    for (const ex of w.exercises) {
      for (let pos = 0; pos < ex.sets.length; pos++) {
        const s = ex.sets[pos];
        logs.push(
          owned({
            id: await uuidv5(`${sessionId}|${ex.name}|${pos}`, ns),
            sessionId, exerciseId: exIds.get(ex.name)!, dayExerciseId, setIndex: setIndex++, setType: s.setType,
            plannedKg: s.kg, plannedReps: s.reps ?? 0, kg: s.kg, reps: s.reps, rpe: s.rpe,
            completed: true, confirmedAt: w.completedAt, sourceSetType: s.sourceSetType,
          }),
        );
      }
    }
  }
  const newExercises: Exercise[] = p.exercises
    .filter((e) => !e.existing)
    .map((e) => owned({ id: e.id, name: e.name, loadType: loadTypes[e.name] ?? e.loadType }));
  const sessionIds = new Set(sessions.map((s) => s.id));
  const logIds = new Set(logs.map((l) => l.id));
  const first = p.workouts[0]?.startedAt ?? now;

  let removed = 0;
  let written = 0;
  await d.transaction('rw', [d.sessions, d.setLogs, d.exercises, d.athleteProgrammes, d.outbox, d.settings], async () => {
    const queued = new Map<SyncedTable, string[]>();
    const q = (table: SyncedTable, ...ids: string[]) => queued.set(table, [...(queued.get(table) ?? []), ...ids]);

    await d.settings.put({ key: 'importNamespace', value: ns });
    const existingAp = await d.athleteProgrammes.get(apId);
    if (!existingAp) {
      const ap: AthleteProgramme = owned({
        id: apId, programmeId, startedOn: new Date(first).toISOString().slice(0, 10), deloadAnchorWeek: 0,
        status: 'done' as const, source: 'import' as const,
      });
      await d.athleteProgrammes.add(ap);
      q('athleteProgrammes', apId);
    }
    // Exercises already known keep their load type; only brand-new names are written.
    if (newExercises.length) {
      await d.exercises.bulkPut(newExercises);
      q('exercises', ...newExercises.map((e) => e.id));
    }

    // A re-imported workout is replaced wholesale. Sets it no longer has are tombstoned.
    // Not where().anyOf(1,000+ ids): that cursor-jumps once per key and took 107 s on 20k sets in
    // tests. One read + an in-memory Set filter took 96 ms.
    const allLogs = await d.setLogs.toArray();
    const existingLogs = allLogs.filter((l) => sessionIds.has(l.sessionId));
    const stale = existingLogs.filter((l) => !logIds.has(l.id) && !l.deletedAt);
    if (stale.length) {
      await d.setLogs.bulkUpdate(stale.map((l) => ({ key: l.id, changes: { deletedAt: now } })));
      q('setLogs', ...stale.map((l) => l.id));
    }
    const toRemove = [...(removeMissing ? p.missing.map((m) => m.sessionId) : []), ...p.replaces.map((r) => r.sessionId)];
    if (toRemove.length) {
      const ids = toRemove;
      const missingIds = new Set(ids);
      const gone = allLogs.filter((l) => missingIds.has(l.sessionId) && !l.deletedAt);
      await d.setLogs.bulkUpdate(gone.map((l) => ({ key: l.id, changes: { deletedAt: now } })));
      await d.sessions.bulkUpdate(ids.map((id) => ({ key: id, changes: { deletedAt: now } })));
      q('setLogs', ...gone.map((l) => l.id));
      q('sessions', ...ids);
      removed = ids.length;
    }

    // Only new or changed rows are written and queued: re-importing the same 7-year file must not
    // rewrite (and later re-upload) 20,000 identical rows.
    const storedSessions = new Map((await d.sessions.bulkGet([...sessionIds])).filter((x) => x).map((x) => [x!.id, x!]));
    const storedLogs = new Map(existingLogs.map((l) => [l.id, l]));
    const changedSessions = sessions.filter((x) => !unchanged(storedSessions.get(x.id), x, SESSION_FIELDS));
    const changedLogs = logs.filter((l) => !unchanged(storedLogs.get(l.id), l, SET_FIELDS));
    await d.sessions.bulkPut(changedSessions);
    await d.setLogs.bulkPut(changedLogs);
    q('sessions', ...changedSessions.map((x) => x.id));
    q('setLogs', ...changedLogs.map((l) => l.id));
    written = changedSessions.length + changedLogs.length + newExercises.length;
    for (const [table, ids] of queued) await queue(table, ...ids);
  });
  return { workouts: sessions.length, sets: logs.length, removed, written };
}

