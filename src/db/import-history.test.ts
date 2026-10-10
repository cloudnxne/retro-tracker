import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import text from '../import/fixtures/strong-sample.csv?raw';
import { parseCsv } from '../import/csv';
import { parseStrong, type ParsedImport } from '../import/strong';
import { RetroDB } from './schema';
import { activeProgramme, db, importProgramme, lastTime, today, useTestDb } from './repo';
import { commitImport, previewImport } from './importHistory';
import { exerciseIdFor } from '../engine/ids';
import { STARTER } from '../data/starter';

let n = 0;
const fresh = () => {
  const d = new RetroDB(`import-test-${++n}`);
  useTestDb(d);
  return d;
};
const parsedFixture = async (csv = text) => parseStrong(await parseCsv(csv), 'kg');
const live = <T extends { deletedAt?: number | null }>(rows: T[]) => rows.filter((r) => !r.deletedAt);

describe('commitImport', () => {
  beforeEach(() => {
    fresh();
  });

  it('writes workouts, sets and a hidden "Imported history" container, all queued for sync', async () => {
    const r = await commitImport(await previewImport(await parsedFixture()));
    expect(r).toEqual({ workouts: 2, sets: 9, removed: 0, written: 2 + 9 + 5 });
    const d = db();
    expect(await d.sessions.count()).toBe(2);
    expect(await d.setLogs.count()).toBe(9);
    expect((await d.sessions.toArray()).every((s) => s.source === 'import' && s.completedAt)).toBe(true);
    const [ap] = await d.athleteProgrammes.toArray();
    expect(ap).toMatchObject({ status: 'done', source: 'import' });
    expect(await d.outbox.where('table').equals('setLogs').count()).toBe(9);
    // The container never shows up as a programme on TODAY.
    expect(await activeProgramme()).toBeUndefined();
    expect((await today()).kind).toBe('no-programme');
  });

  it('is idempotent: importing the same file twice changes nothing', async () => {
    await commitImport(await previewImport(await parsedFixture()));
    const p2 = await previewImport(await parsedFixture());
    expect(p2.alreadyImported).toBe(2);
    expect(p2.missing).toEqual([]);
    const outboxBefore = await db().outbox.count();
    const r2 = await commitImport(p2);
    expect(r2.written).toBe(0); // nothing rewritten…
    expect(await db().outbox.count()).toBe(outboxBefore); // …and nothing re-queued for upload
    expect(await db().sessions.count()).toBe(2);
    expect(live(await db().setLogs.toArray())).toHaveLength(9);
  });

  it('re-import replaces a workout wholesale: a deleted set disappears, an edit updates, no duplicates', async () => {
    await commitImport(await previewImport(await parsedFixture()));
    const edited = text
      .split('\n')
      .filter((l) => !l.includes('"Squat (Barbell)";"2";"100.0"')) // set deleted in Strong
      .join('\n')
      .replace('"Bench Press (Barbell)";"2";"70.5"', '"Bench Press (Barbell)";"2";"72.5"'); // set edited
    await commitImport(await previewImport(await parsedFixture(edited)));
    const sets = live(await db().setLogs.toArray());
    expect(sets).toHaveLength(8);
    expect(sets.filter((s) => s.kg === 72.5)).toHaveLength(1);
    expect(sets.filter((s) => s.kg === 70.5)).toHaveLength(1);
  });

  it('lists workouts that left the file, and removes them only when asked', async () => {
    await commitImport(await previewImport(await parsedFixture()));
    const onlyA = text.split('\n').filter((l) => !l.includes('Workout B') && !l.startsWith('line note')).join('\n');
    const p = await previewImport(await parsedFixture(onlyA));
    expect(p.missing).toHaveLength(1);
    await commitImport(p);
    expect(live(await db().sessions.toArray())).toHaveLength(2); // kept
    const r = await commitImport(await previewImport(await parsedFixture(onlyA)), { removeMissing: true });
    expect(r.removed).toBe(1);
    expect(live(await db().sessions.toArray())).toHaveLength(1);
  });

  it('skips an imported workout within 2 h of an app-logged session that day', async () => {
    await db().sessions.add({
      id: 'app-1', athleteProgrammeId: 'ap', dayId: 'd', week: 1, isDeload: false, planSnapshot: [],
      startedAt: new Date(2024, 0, 8, 19, 0).getTime(), completedAt: new Date(2024, 0, 8, 20, 0).getTime(),
    });
    const p = await previewImport(await parsedFixture());
    expect(p.overlaps).toEqual([{ name: 'Workout A', at: new Date(2024, 0, 8, 18, 0).getTime() }]);
    expect(p.workouts.map((w) => w.name)).toEqual(['Workout B']);
  });

  it('two accounts importing the same file never share an id', async () => {
    await commitImport(await previewImport(await parsedFixture()));
    const a = new Set([...(await db().sessions.toArray()), ...(await db().setLogs.toArray()), ...(await db().athleteProgrammes.toArray())].map((r) => r.id));
    fresh();
    await commitImport(await previewImport(await parsedFixture()));
    const b = [...(await db().sessions.toArray()), ...(await db().setLogs.toArray()), ...(await db().athleteProgrammes.toArray())].map((r) => r.id);
    expect(b.filter((id) => a.has(id))).toEqual([]);
  });

  it('a failure mid-write leaves zero rows behind', async () => {
    const p = await previewImport(await parsedFixture());
    const d = db();
    const original = d.setLogs.bulkPut.bind(d.setLogs);
    d.setLogs.bulkPut = (() => Promise.reject(new Error('disk full'))) as unknown as typeof d.setLogs.bulkPut;
    await expect(commitImport(p)).rejects.toThrow('disk full');
    d.setLogs.bulkPut = original;
    expect(await d.sessions.count()).toBe(0);
    expect(await d.setLogs.count()).toBe(0);
    expect(await d.athleteProgrammes.count()).toBe(0);
    expect(await d.exercises.count()).toBe(0);
    expect(await d.outbox.count()).toBe(0);
  });

  it('keeps a known exercise load type and applies review overrides to new ones', async () => {
    const p = await previewImport(await parsedFixture());
    const pause = p.exercises.find((e) => e.name === 'pause squat')!;
    expect(pause).toMatchObject({ existing: false, certain: false, loadType: 'barbell' });
    expect(p.exercises[0].certain).toBe(false); // uncertain ones first, for the review list
    await commitImport(p, { loadTypes: { 'pause squat': 'machine' } });
    expect((await db().exercises.get(pause.id))?.loadType).toBe('machine');
  });
});

describe('imports and progression', () => {
  beforeEach(() => {
    fresh();
  });

  it('first session after an import holds at the last imported top working weight', async () => {
    await commitImport(await previewImport(await parsedFixture()));
    await importProgramme(STARTER);
    const t = await today();
    if (t.kind !== 'ready') throw new Error(t.kind);
    const squat = t.plan.find((p) => p.name === 'Squat (Barbell)')!;
    expect(squat).toMatchObject({ suggestedKg: 100, outcome: 'imported' });
    // An exercise with no imported history still asks.
    expect(t.plan.find((p) => p.name === 'Seated Cable Row')!.outcome).toBe('first-time');
  });

  it('LAST TIME shows the imported top set', async () => {
    await commitImport(await previewImport(await parsedFixture()));
    expect(await lastTime(await exerciseIdFor('Bench Press (Barbell)'))).toEqual({ kg: 70.5, reps: 8, rpe: 7.5 });
  });
});

describe('scale', () => {
  it('previews and commits ~20,000 sets in one go', async () => {
    fresh();
    const workouts = Array.from({ length: 1_000 }, (_, i) => {
      const t = new Date(2019, 0, 1 + i, 18, 0).getTime();
      return {
        key: `w${i}`, name: 'Workout', localDate: new Date(t).toISOString().slice(0, 10), startedAt: t, completedAt: t + 3_600_000,
        exercises: Array.from({ length: 4 }, (_, e) => ({
          name: ['Squat (Barbell)', 'Bench Press (Barbell)', 'Deadlift (Barbell)', 'Pull Up'][e],
          sets: Array.from({ length: 5 }, () => ({ setType: 'straight' as const, sourceSetType: null, kg: 100, reps: 5, rpe: null })),
        })),
      };
    });
    const parsed: ParsedImport = { format: 'strong', source: 'strong', unit: 'kg', workouts, skipped: { restTimers: 0, notes: 0, cardio: 0 }, errors: [], setCount: 20_000 };
    const t0 = performance.now();
    const r = await commitImport(await previewImport(parsed));
    const ms = performance.now() - t0;
    expect(r.sets).toBe(20_000);
    expect(await db().setLogs.count()).toBe(20_000);
    // fake-indexeddb is far slower than a phone's IndexedDB; this guards against accidental O(n²).
    expect(ms).toBeLessThan(10_000); // measured ~2.3 s
    console.log(`[scale] 20k-set import: ${Math.round(ms)} ms (fake-indexeddb)`);
  }, 60_000);
});
