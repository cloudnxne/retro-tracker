import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import strongCsv from './fixtures/strong-sample.csv?raw';
import { parseCsv } from './csv';
import { parseStrong } from './strong';
import { changedFromTarget, isTrackerLog, isTrackerTemplate, parseTrackerLogs } from './trackerLog';
import { RetroDB } from '../db/schema';
import { db, useTestDb } from '../db/repo';
import { commitImport, previewImport } from '../db/importHistory';

/** Synthetic tracker logs (invented numbers) in the PHP tracker's shape. */
const set = (label: string, targetKg: number | null, targetReps: string, loggedKg: number | null, loggedReps: number, completed: boolean, loggedRpe: number | null = null) => ({
  label, targetKg, targetReps, targetRpe: null, loggedKg, loggedReps, loggedRpe, completed,
});
const log = (date: string, time: string, day: string, extra: Record<string, unknown> = {}) => ({
  date,
  completedAt: `${date}T${time}.000Z`,
  phase: 'ph1',
  phaseName: 'Base 1',
  day,
  sessionName: `${day} - Squat`,
  exercises: [
    {
      name: 'Squat (Barbell)',
      tag: 'ANCHOR',
      sets: [set('W', 60, '5', 60, 5, true), set('1', 100, '6', 100, 6, true), set('2', 100, '4–6', 100, 4, false), set('3', 100, '6', 102.5, 6, false)],
    },
    { name: 'Pause Squat', tag: 'SUPP', sets: [set('1', null, '12', 50, 12, false), set('2', null, '12', null, 12, false)] },
  ],
  ...extra,
});
const template = { phase: 'ph1', day: 'mon', exercises: [{ id: 'squat', name: 'Squat (Barbell)', sets: [] }] };
const files = (...xs: unknown[]) => xs.map((json, i) => ({ name: `f${i}.json`, json }));

describe('tracker log format', () => {
  it('tells logs from templates', () => {
    expect(isTrackerLog(log('2024-01-08', '07:00:00', 'mon'))).toBe(true);
    expect(isTrackerTemplate(template)).toBe(true);
    expect(isTrackerLog(template)).toBe(false);
    expect(isTrackerLog({ hello: 1 })).toBe(false);
  });

  it('counts an unticked set only if its numbers were changed from the target', () => {
    expect(changedFromTarget(set('1', 100, '6', 100, 6, false))).toBe(false); // untouched prefill
    expect(changedFromTarget(set('1', 100, '4–6', 100, 4, false))).toBe(false); // prefill = bottom of range
    expect(changedFromTarget(set('1', 100, '6', 102.5, 6, false))).toBe(true); // weight edited
    expect(changedFromTarget(set('1', 100, '6', 100, 8, false))).toBe(true); // reps edited
    expect(changedFromTarget(set('1', null, '12', 50, 12, false))).toBe(true); // weight typed into an RPE set
    expect(changedFromTarget(set('1', null, '12', null, 12, false))).toBe(false);
  });

  it('parses sets: W = warm-up, ticked or edited sets kept, untouched prefills skipped', () => {
    const p = parseTrackerLogs(files(log('2024-01-08', '07:00:00', 'mon')), 'kg');
    const [w] = p.workouts;
    expect(w.exercises[0].sets.map((s) => [s.setType, s.kg, s.reps])).toEqual([
      ['warmup', 60, 5],
      ['straight', 100, 6],
      ['straight', 102.5, 6],
    ]);
    expect(w.exercises[1].sets.map((s) => s.kg)).toEqual([50]);
    expect(p.skipped.untickedUnchanged).toBe(2);
    expect(p.setCount).toBe(4);
    expect(w).toMatchObject({ localDate: '2024-01-08', name: 'mon - Squat', isDeload: false });
  });

  it('keeps the latest of duplicate saves, skips templates, flags non-logs, marks deloads', () => {
    const early = log('2024-01-08', '07:00:00', 'mon');
    const late = log('2024-01-08', '10:00:00', 'mon');
    (late.exercises[0].sets[1] as { loggedKg: number }).loggedKg = 105;
    const p = parseTrackerLogs(files(late, early, template, { nope: true }, log('2024-01-09', '07:00:00', 'tue', { phase: 'deload' })), 'kg');
    expect(p.workouts).toHaveLength(2);
    expect(p.workouts[0].exercises[0].sets[1].kg).toBe(105);
    expect(p.skipped).toMatchObject({ duplicateSaves: 1, templates: 1 });
    expect(p.errors).toEqual([{ row: 4, message: 'f3.json: not a workout log' }]);
    expect(p.workouts[1].isDeload).toBe(true);
  });

  it('accepts one combined file holding many logs', () => {
    const p = parseTrackerLogs([{ name: 'all.json', json: [log('2024-01-08', '07:00:00', 'mon'), log('2024-01-09', '07:00:00', 'tue'), template] }], 'kg');
    expect(p.workouts).toHaveLength(2);
    expect(p.skipped.templates).toBe(1);
  });

  it('keeps two different days saved on the same date', () => {
    const p = parseTrackerLogs(files(log('2024-01-08', '07:00:00', 'mon'), log('2024-01-08', '07:01:00', 'tue')), 'kg');
    expect(p.workouts).toHaveLength(2);
  });
});

describe('two sources, one history: the tracker wins on the same day', () => {
  beforeEach(() => {
    useTestDb(new RetroDB(`tracker-src-${Math.random()}`));
  });
  const strong = async () => parseStrong(await parseCsv(strongCsv), 'kg'); // workouts on 2024-01-08 and 2024-01-10
  const tracker = () => parseTrackerLogs(files(log('2024-01-10', '07:00:00', 'wed')), 'kg');
  const liveSessions = async () => (await db().sessions.toArray()).filter((s) => !s.deletedAt);

  it('tracker after Strong: replaces Strong on that day, never flags other Strong days as missing', async () => {
    await commitImport(await previewImport(await strong()));
    const p = await previewImport(tracker());
    expect(p.replaces.map((r) => r.from)).toEqual(['strong']);
    expect(p.missing).toEqual([]);
    const r = await commitImport(p);
    expect(r.removed).toBe(1);
    const left = await liveSessions();
    expect(left.map((s) => s.importSource).sort()).toEqual(['strong', 'tracker']);
  });

  it('Strong after tracker: the covered day is skipped, not duplicated', async () => {
    await commitImport(await previewImport(tracker()));
    const p = await previewImport(await strong());
    expect(p.covered).toEqual([{ name: 'Workout B', at: expect.any(Number), by: 'tracker' }]);
    expect(p.workouts.map((w) => w.name)).toEqual(['Workout A']);
    expect(p.missing).toEqual([]);
    await commitImport(p);
    expect((await liveSessions()).length).toBe(2);
  });

  it('re-importing Strong later still respects the tracker day and does not resurrect it', async () => {
    await commitImport(await previewImport(await strong()));
    await commitImport(await previewImport(tracker()));
    const again = await previewImport(await strong());
    expect(again.covered).toHaveLength(1);
    expect(again.missing.map((m) => m.sessionId)).toHaveLength(0); // the replaced Strong day was tombstoned, not "missing"
    await commitImport(again);
    expect((await liveSessions()).length).toBe(2);
  });
});
