import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { RetroDB, dbName, GUEST } from './schema';
import {
  claimGuestData,
  confirmSet,
  db,
  discardSession,
  editSet,
  exportSetsCsv,
  finishSession,
  importProgramme,
  restartProgramme,
  sessionSets,
  setSetting,
  startSession,
  switchAccount,
  today,
  useTestDb,
} from './repo';
import { validateProgramme, ProgrammeError } from './validate';
import { exerciseIdFor } from '../engine/ids';

const ex = (name: string, extra: Record<string, unknown> = {}) => ({
  name, loadType: 'barbell', restSec: 120, sets: 2, repMin: 5, repMax: 5, targetRpe: null,
  prescribedKg: null, progression: 'auto', warmups: [], ...extra,
});
const programme = {
  name: 'Two-day test',
  deloadEvery: 0,
  blocks: [{ name: 'Only', weeks: 1, days: [{ name: 'A', exercises: [ex('Squat (Barbell)', { prescribedKg: 100 })] }, { name: 'B', exercises: [ex('Bench Press (Barbell)', { prescribedKg: 60 })] }] }],
};

async function ready() {
  const t = await today();
  if (t.kind !== 'ready') throw new Error(`expected ready, got ${t.kind}`);
  return t;
}

/** Log every set of today's session at the given weight and finish it. */
async function doDay(kg?: number) {
  const s = await startSession(await ready());
  for (const l of await sessionSets(s.id)) {
    if (kg !== undefined) await editSet(l, { kg });
    await confirmSet({ ...l, kg: kg ?? l.kg }, null);
  }
  return finishSession(s.id);
}

let n = 0;
beforeEach(async () => {
  useTestDb(new RetroDB(`eng-${n++}`));
  await importProgramme(programme);
});

describe('outbox completeness', () => {
  it('import queues the whole programme tree and its exercises', async () => {
    const tables = (await db().outbox.toArray()).map((o) => o.table);
    for (const t of ['programmes', 'blocks', 'days', 'dayExercises', 'exercises', 'athleteProgrammes']) {
      expect(tables).toContain(t);
    }
    expect(tables.filter((t) => t === 'dayExercises')).toHaveLength(2);
  });

  it('starting a session queues EVERY set log, not just touched ones', async () => {
    const s = await startSession(await ready());
    const queued = new Set((await db().outbox.where('table').equals('setLogs').toArray()).map((o) => o.rowId));
    for (const l of await sessionSets(s.id)) expect(queued.has(l.id)).toBe(true);
  });

  it('settings and timers are never queued', async () => {
    await setSetting('units', 'lb');
    await db().timers.put({ key: 'rest', endsAt: 1, totalSec: 1, sessionId: 'x' });
    const tables = new Set((await db().outbox.toArray()).map((o) => o.table as string));
    expect(tables.has('settings')).toBe(false);
    expect(tables.has('timers')).toBe(false);
  });
});

describe('exercise ids', () => {
  it('uses the name-derived id, and re-importing reuses it', async () => {
    const id = await exerciseIdFor('Squat (Barbell)');
    expect(await db().exercises.get(id)).toBeDefined();
    await importProgramme(programme);
    expect(await db().exercises.count()).toBe(2);
  });
});

describe('derived position + finished state', () => {
  it('advances by completed sessions and reports finished after the last day', async () => {
    expect((await ready()).dayName).toBe('A');
    await doDay();
    expect((await ready()).dayName).toBe('B');
    await doDay();
    const t = await today();
    expect(t.kind).toBe('finished');
  });

  it('"Run it again" starts a fresh programme at week 1 day A', async () => {
    await doDay();
    await doDay();
    const t = await today();
    if (t.kind !== 'finished') throw new Error(t.kind);
    await restartProgramme(t.ap);
    expect(await ready()).toMatchObject({ week: 1, dayName: 'A' });
  });

  it('no active programme → no-programme', async () => {
    useTestDb(new RetroDB(`eng-empty-${n++}`));
    expect((await today()).kind).toBe('no-programme');
  });
});

describe('PR detection', () => {
  it('first-ever session is not a PR (no history)', async () => {
    expect((await doDay()).prs).toEqual([]);
  });

  it('a heavier set than history is a PR with the right delta; the same weight is not', async () => {
    await doDay(); // A @100
    await doDay(); // B
    let t = await today();
    if (t.kind !== 'finished') throw new Error(t.kind);
    await restartProgramme(t.ap);
    const same = await doDay(100); // A again @100
    expect(same.prs).toEqual([]);
    await doDay(); // B
    t = await today();
    if (t.kind !== 'finished') throw new Error(t.kind);
    await restartProgramme(t.ap);
    const heavier = await doDay(110); // A @110
    // Epley 5 reps: 100 → 116.7, 110 → 128.3
    expect(heavier.prs).toEqual([{ name: 'Squat (Barbell)', e1rm: 128.3, delta: 11.6 }]);
  });
});

describe('tombstones + timer cleanup', () => {
  it('discard marks the session and its sets deleted, queues them, and history ignores it', async () => {
    const s = await startSession(await ready());
    const [first] = await sessionSets(s.id);
    await confirmSet(first, null);
    await db().timers.put({ key: 'rest', endsAt: Date.now() + 60_000, totalSec: 60, sessionId: s.id });
    await discardSession(s.id);
    expect((await db().sessions.get(s.id))?.deletedAt).toBeTruthy();
    expect(await sessionSets(s.id)).toEqual([]);
    expect(await db().timers.get('rest')).toBeUndefined();
    const queuedSessions = (await db().outbox.where('table').equals('sessions').toArray()).map((o) => o.rowId);
    expect(queuedSessions).toContain(s.id);
    expect((await today()).kind).toBe('ready'); // not "in-session", and day A is still next
    expect((await ready()).dayName).toBe('A');
    expect(await exportSetsCsv()).toBe('date,exercise,set,kg,reps,rpe,warmup');
  });

  it('finishing clears the rest timer', async () => {
    const s = await startSession(await ready());
    await db().timers.put({ key: 'rest', endsAt: Date.now() + 60_000, totalSec: 60, sessionId: s.id });
    await finishSession(s.id);
    expect(await db().timers.get('rest')).toBeUndefined();
  });
});

describe('live session only on the device that started it', () => {
  it('another device sees "ready" with the session flagged elsewhere', async () => {
    await setSetting('deviceId', 'phone-1');
    const s = await startSession(await ready());
    expect((await today()).kind).toBe('in-session');
    await setSetting('deviceId', 'laptop-2');
    const t = await today();
    expect(t.kind).toBe('ready');
    if (t.kind === 'ready') expect(t.elsewhere?.id).toBe(s.id);
  });
});

describe('per-account storage + guest claim', () => {
  it('claims guest data once into the account, stamps ownerId, queues it, and removes the guest DB', async () => {
    // Use the real guest DB name for this test.
    await RetroDB.delete(dbName(GUEST));
    switchAccount(GUEST);
    await importProgramme(programme);
    await doDay();
    const { claimed } = await claimGuestData('user-1');
    expect(claimed).toBeGreaterThan(5);
    expect(await RetroDB.exists(dbName(GUEST))).toBe(false);
    switchAccount('user-1');
    const sessions = await db().sessions.toArray();
    expect(sessions).toHaveLength(1);
    expect(sessions.every((s) => s.ownerId === 'user-1')).toBe(true);
    expect(await db().outbox.count()).toBeGreaterThanOrEqual(claimed);
  });

  it('a second person on the same phone never sees the first person\'s data', async () => {
    switchAccount('user-a');
    await importProgramme(programme);
    await doDay();
    switchAccount('user-b');
    expect((await today()).kind).toBe('no-programme');
    expect(await db().sessions.count()).toBe(0);
    switchAccount('user-a');
    expect(await db().sessions.count()).toBe(1);
  });
});

describe('import validation', () => {
  const base = () => JSON.parse(JSON.stringify(programme));
  const bad = (mutate: (p: ReturnType<typeof base>) => void) => {
    const p = base();
    mutate(p);
    return () => validateProgramme(p);
  };
  it('accepts a valid programme', () => expect(() => validateProgramme(base())).not.toThrow());
  it.each([
    ['missing name', (p: any) => delete p.name, /needs a name/],
    ['no blocks', (p: any) => (p.blocks = []), /at least one block/],
    ['weeks 0', (p: any) => (p.blocks[0].weeks = 0), /Block 1: weeks must be 1–52/],
    ['string sets', (p: any) => (p.blocks[0].days[0].exercises[0].sets = '4'), /Squat \(Barbell\): sets must be/],
    ['repMin > repMax', (p: any) => Object.assign(p.blocks[0].days[0].exercises[0], { repMin: 12, repMax: 8 }), /repMin > repMax/],
    ['bad loadType', (p: any) => (p.blocks[0].days[1].exercises[0].loadType = 'kettlebell'), /Day "B" › Bench Press \(Barbell\): loadType/],
    ['rpe 11', (p: any) => (p.blocks[0].days[0].exercises[0].targetRpe = 11), /targetRpe/],
    ['rest 2000', (p: any) => (p.blocks[0].days[0].exercises[0].restSec = 2000), /restSec/],
    ['negative kg', (p: any) => (p.blocks[0].days[0].exercises[0].prescribedKg = -5), /prescribedKg/],
    ['bad warm-up', (p: any) => (p.blocks[0].days[0].exercises[0].warmups = [{ kg: 20, reps: 0 }]), /warm-up 1: reps/],
  ])('rejects %s with a named error', (_label, mutate, msg) => {
    expect(bad(mutate as never)).toThrow(ProgrammeError);
    expect(bad(mutate as never)).toThrow(msg);
  });
});

describe('programme import and existing exercises', () => {
  it("uses the programme's spelling for an exercise that history created first", async () => {
    useTestDb(new RetroDB(`spelling-${Math.random()}`));
    const id = await exerciseIdFor('Pause Squat');
    await db().exercises.add({ id, name: 'pause squat', loadType: 'barbell' });
    await importProgramme({ ...programme, blocks: [{ name: 'B', weeks: 1, days: [{ name: 'A', exercises: [ex('Pause Squat')] }] }] });
    expect((await db().exercises.get(id))?.name).toBe('Pause Squat');
    expect(await db().exercises.count()).toBe(1);
  });
});

describe('plates & bar setting drives suggestions', () => {
  const oneDay = { ...programme, blocks: [{ name: 'B', weeks: 3, days: [{ name: 'A', exercises: [ex('Squat (Barbell)', { prescribedKg: 100 })] }] }] };
  const nextSquat = async () => (await ready()).plan[0].suggestedKg;

  it('full plate set: hitting every rep adds 2.5 kg', async () => {
    useTestDb(new RetroDB(`plates-${Math.random()}`));
    await importProgramme(oneDay);
    await doDay();
    expect(await nextSquat()).toBe(102.5);
  });

  it('no plates under 5 kg: the jump is the smallest the plates allow (10 kg), not a 2.5 that rounds away', async () => {
    useTestDb(new RetroDB(`plates-${Math.random()}`));
    const { setPlateSetup, getPlateSetup } = await import('./repo');
    await setPlateSetup('kg', { plates: [20, 10, 5], bar: 20 });
    expect(await getPlateSetup('kg')).toEqual({ plates: [20, 10, 5], bar: 20 });
    await importProgramme(oneDay);
    await doDay();
    expect(await nextSquat()).toBe(110);
  });

  it('refuses an empty plate set', async () => {
    const { setPlateSetup } = await import('./repo');
    await expect(setPlateSetup('kg', { plates: [], bar: 20 })).rejects.toThrow(RangeError);
  });
});

describe('plate-loaded machines', () => {
  it('progress a plate each side, with no bar, and equipment can be switched later', async () => {
    useTestDb(new RetroDB(`plate-loaded-${Math.random()}`));
    const { setExerciseLoadType } = await import('./repo');
    await importProgramme({ ...programme, blocks: [{ name: 'B', weeks: 3, days: [{ name: 'A', exercises: [ex('Leg Press', { loadType: 'plates', prescribedKg: 100, repMin: 10, repMax: 10 })] }] }] });
    await doDay();
    expect((await ready()).plan[0]).toMatchObject({ suggestedKg: 105, loadType: 'plates' });

    const id = await exerciseIdFor('Leg Press');
    await setExerciseLoadType(id, 'machine');
    expect((await db().exercises.get(id))?.loadType).toBe('machine');
    expect(await db().outbox.where('[table+rowId]').equals(['exercises', id]).count()).toBeGreaterThan(0);
  });
});
