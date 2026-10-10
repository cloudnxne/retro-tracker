import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { RetroDB } from '../db/schema';
import {
  confirmSet,
  db,
  discardSession,
  editSet,
  finishSession,
  importProgramme,
  sessionSets,
  startSession,
  today,
  useTestDb,
  exerciseHistory,
} from '../db/repo';
import { SyncEngine } from './engine';
import { FakeSupabase } from './fakeSupabase';

/**
 * Sync scenarios written against an FK-enforcing fake server.
 *
 *   phone-1 (RetroDB) ──push──► FakeSupabase ──pull──► phone-2 (RetroDB)
 */
const USER = '00000000-0000-4000-8000-000000000001';
const programme = {
  name: 'Sync test',
  deloadEvery: 0,
  blocks: [
    {
      name: 'Base',
      weeks: 2,
      days: [
        { name: 'A', exercises: [{ name: 'Squat (Barbell)', loadType: 'barbell', restSec: 120, sets: 2, repMin: 5, repMax: 5, targetRpe: null, prescribedKg: 100, warmups: [] }] },
        { name: 'B', exercises: [{ name: 'Bench Press (Barbell)', loadType: 'barbell', restSec: 120, sets: 2, repMin: 5, repMax: 5, targetRpe: null, prescribedKg: 60, warmups: [] }] },
      ],
    },
  ],
};

let n = 0;
let server: FakeSupabase;
let phone1: RetroDB;
let phone2: RetroDB;
const on = (phone: RetroDB) => useTestDb(phone, USER);
const engine = (phone: RetroDB) => new SyncEngine(() => phone, server, USER);

async function doDay() {
  const t = await today();
  if (t.kind !== 'ready') throw new Error(t.kind);
  const s = await startSession(t);
  for (const l of await sessionSets(s.id)) await confirmSet(l, null);
  await finishSession(s.id);
  return s;
}

beforeEach(async () => {
  server = new FakeSupabase();
  phone1 = new RetroDB(`sync-p1-${n}`);
  phone2 = new RetroDB(`sync-p2-${n++}`);
  on(phone1);
  await importProgramme(programme);
});

describe('push', () => {
  it('first flush uploads the programme tree, sessions and sets in FK order (no FK failures)', async () => {
    await doDay();
    expect(await engine(phone1).flush()).toBe('ok');
    expect(await phone1.outbox.count()).toBe(0);
    expect(await phone1.deadLetters.count()).toBe(0);
    expect(server.rows('programme_days')).toHaveLength(2);
    expect(server.rows('sessions')).toHaveLength(1);
    expect(server.rows('set_logs')).toHaveLength(2);
    const order = server.calls.filter((c) => c.op === 'upsert').map((c) => c.table);
    expect(order.indexOf('programmes')).toBeLessThan(order.indexOf('programme_blocks'));
    expect(order.indexOf('sessions')).toBeLessThan(order.indexOf('set_logs'));
  });

  it('is idempotent: pushing the same rows twice leaves one copy', async () => {
    const s = await doDay();
    await engine(phone1).flush();
    await phone1.outbox.bulkAdd([{ table: 'sessions', rowId: s.id, createdAt: Date.now() }]);
    await engine(phone1).flush();
    expect(server.rows('sessions')).toHaveLength(1);
  });

  it('network drop mid-flush keeps the rest queued; nothing is lost when it comes back', async () => {
    await doDay();
    server.dropAfter = 2;
    expect(await engine(phone1).flush()).toBe('offline');
    expect(await phone1.outbox.count()).toBeGreaterThan(0);
    server.dropAfter = null;
    expect(await engine(phone1).flush()).toBe('ok');
    expect(await phone1.outbox.count()).toBe(0);
    expect(server.rows('set_logs')).toHaveLength(2);
  });

  it('expired token: refreshes once, then flushes', async () => {
    await doDay();
    server.tokenExpired = true;
    expect(await engine(phone1).flush()).toBe('ok');
    expect(server.rows('sessions')).toHaveLength(1);
  });

  it('refresh fails: reports signed-out and never drops the queue', async () => {
    await doDay();
    const queued = await phone1.outbox.count();
    server.tokenExpired = true;
    server.refreshWorks = false;
    expect(await engine(phone1).flush()).toBe('signed-out');
    expect(await phone1.outbox.count()).toBe(queued);
  });

  it('one poison row goes to dead-letters; everything else still syncs (queue never jams)', async () => {
    const s = await doDay();
    const [first] = await sessionSets(s.id);
    server.poison = (table, row) => (table === 'set_logs' && row.id === first.id ? 'violates check constraint "rpe"' : null);
    expect(await engine(phone1).flush()).toBe('ok');
    expect(await phone1.outbox.count()).toBe(0);
    const dead = await phone1.deadLetters.toArray();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ table: 'setLogs', rowId: first.id, status: 400 });
    expect(server.rows('set_logs')).toHaveLength(1);
    expect(server.rows('events').length).toBeGreaterThan(0); // tables after it still synced
  });

  it('an edit made while a flush is running stays queued for the next flush', async () => {
    const s = await doDay();
    const [first] = await sessionSets(s.id);
    // Simulate: the flush read the queue, then the user edited before it finished.
    const eng = engine(phone1);
    const origUpsert = server.upsert.bind(server);
    let edited = false;
    server.upsert = async (table, rows, oc) => {
      if (table === 'set_logs' && !edited) {
        edited = true;
        await editSet({ ...first, completed: true }, { rpe: 8 });
      }
      return origUpsert(table, rows, oc);
    };
    await eng.flush();
    const pending = await phone1.outbox.where('table').equals('setLogs').toArray();
    expect(pending.map((p) => p.rowId)).toContain(first.id);
  });
});

describe('pull', () => {
  it('a second device restores the full history and serves the same next day', async () => {
    await doDay();
    await engine(phone1).flush();
    on(phone2);
    expect(await engine(phone2).pull()).toBe('ok');
    const t = await today();
    expect(t.kind === 'ready' && t.dayName).toBe('B');
    const squat = (await phone2.exercises.toArray()).find((e) => e.name === 'Squat (Barbell)')!;
    expect(await exerciseHistory(squat.id)).toHaveLength(1);
  });

  it('server wins for programmes: a PT rename reaches the phone', async () => {
    await engine(phone1).flush();
    const prog = server.rows('programmes')[0];
    server.serverWrite('programmes', { ...prog, name: 'Renamed by PT' });
    await engine(phone1).pull();
    expect((await phone1.programmes.toArray())[0].name).toBe('Renamed by PT');
  });

  it('local wins for sessions: an unpushed local change is not overwritten by an older server copy', async () => {
    const s = await doDay();
    await engine(phone1).flush();
    on(phone1);
    await phone1.sessions.update(s.id, { week: 1, isDeload: true });
    await phone1.outbox.add({ table: 'sessions', rowId: s.id, createdAt: Date.now() });
    await engine(phone1).pull();
    expect((await phone1.sessions.get(s.id))?.isDeload).toBe(true);
  });

  it('tombstones propagate: a session discarded on phone 1 disappears on phone 2', async () => {
    const t = await today();
    if (t.kind !== 'ready') throw new Error(t.kind);
    const s = await startSession(t);
    await engine(phone1).flush();
    on(phone2);
    await engine(phone2).pull();
    expect(await phone2.sessions.get(s.id)).toBeDefined();
    on(phone1);
    await discardSession(s.id);
    await engine(phone1).flush();
    on(phone2);
    await engine(phone2).pull();
    expect((await phone2.sessions.get(s.id))?.deletedAt).toBeTruthy();
    expect((await today()).kind).toBe('ready');
  });

  it('a late-committed row (older than the watermark, inside the 5-min overlap) still arrives', async () => {
    await engine(phone1).flush();
    on(phone2);
    await engine(phone2).pull();
    const mark = (((await phone2.settings.get('syncWatermarks'))?.value) as Record<string, string>).days;
    const day = server.rows('programme_days')[0];
    const twoMinBefore = new Date(Date.parse(mark) - 120_000).toISOString();
    server.serverWrite('programme_days', { ...day, name: 'Late edit' }, 'id', twoMinBefore);
    await engine(phone2).pull();
    expect((await phone2.days.get(String(day.id)))?.name).toBe('Late edit');
  });

  it('only pulls my own athlete rows (another user’s sessions are ignored)', async () => {
    await doDay();
    await engine(phone1).flush();
    const other = server.rows('sessions')[0];
    server.serverWrite('sessions', { ...other, id: 'someone-else', athlete_id: 'other-user' });
    on(phone2);
    await engine(phone2).pull();
    expect(await phone2.sessions.get('someone-else')).toBeUndefined();
  });

  it('offline pull reports offline and changes nothing', async () => {
    server.offline = true;
    on(phone2);
    expect(await engine(phone2).sync()).toBe('offline');
    expect(await db().programmes.count()).toBe(0);
  });
});

describe('FUEL tables (v3)', () => {
  it('nutrition days and bodyweight upload, and a second device restores them by date', async () => {
    on(phone1);
    await db().nutritionDays.put({ id: '2026-09-30', protein: 160, kcal: 2600, targetG: 150, updatedAt: 1 });
    await db().bodyweightLogs.put({ id: '2026-10-01', kg: 82.4, updatedAt: 1 });
    await db().outbox.bulkAdd([
      { table: 'nutritionDays', rowId: '2026-09-30', createdAt: 1 },
      { table: 'bodyweightLogs', rowId: '2026-10-01', createdAt: 1 },
    ]);
    expect(await engine(phone1).sync()).toBe('ok');
    expect(await phone1.outbox.count()).toBe(0);
    const row = server.rows('nutrition_days')[0];
    expect(row).toMatchObject({ athlete_id: USER, date: '2026-09-30', protein: 160, kcal: 2600, target_g: 150 });

    on(phone2);
    expect(await engine(phone2).sync()).toBe('ok');
    expect(await phone2.nutritionDays.get('2026-09-30')).toMatchObject({ protein: 160, kcal: 2600, targetG: 150 });
    expect(await phone2.bodyweightLogs.get('2026-10-01')).toMatchObject({ kg: 82.4 });
  });

  it('editing the same day twice keeps one server row (keyed by athlete + date)', async () => {
    on(phone1);
    for (const protein of [120, 170]) {
      await db().nutritionDays.put({ id: '2026-09-30', protein, kcal: null, targetG: null, updatedAt: protein });
      await db().outbox.add({ table: 'nutritionDays', rowId: '2026-09-30', createdAt: protein });
      await engine(phone1).flush();
    }
    expect(server.rows('nutrition_days')).toHaveLength(1);
    expect(server.rows('nutrition_days')[0].protein).toBe(170);
  });
});
