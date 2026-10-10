import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { RetroDB } from './schema';
import {
  confirmSet,
  editSet,
  finishSession,
  importProgramme,
  sessionSets,
  startSession,
  today,
  useTestDb,
  pendingSyncCount,
  exportSetsCsv,
} from './repo';

const programme = {
  name: 'Test Push/Pull',
  deloadEvery: 4,
  blocks: [
    {
      name: 'Base',
      weeks: 4,
      days: [
        {
          name: 'Push',
          exercises: [
            { name: 'Bench Press (Barbell)', loadType: 'barbell', restSec: 120, sets: 3, repMin: 6, repMax: 8, targetRpe: 8, prescribedKg: 80, progression: 'auto', warmups: [{ kg: 40, reps: 10 }] },
            { name: 'Overhead Press (Barbell)', loadType: 'barbell', restSec: 120, sets: 2, repMin: 5, repMax: 5, targetRpe: null, prescribedKg: 40, warmups: [] },
          ],
        },
        {
          name: 'Pull',
          exercises: [
            { name: 'Pull-Up', loadType: 'bodyweight', restSec: 90, sets: 3, repMin: 5, repMax: 8, targetRpe: null, prescribedKg: null, warmups: [] },
          ],
        },
      ],
    },
  ],
};

let n = 0;
beforeEach(async () => {
  useTestDb(new RetroDB(`test-${n++}`));
  await importProgramme(programme);
});

async function runDay(reps: number) {
  const t = await today();
  if (t.kind !== 'ready') throw new Error(`expected ready, got ${t.kind}`);
  const s = await startSession(t);
  for (const log of await sessionSets(s.id)) {
    if (log.setType === 'straight') await editSet(log, { reps });
    await confirmSet({ ...log, reps: log.setType === 'straight' ? reps : log.reps }, null);
  }
  return { plan: t, summary: await finishSession(s.id) };
}

describe('session loop', () => {
  it('first session uses the programme weight, then progresses after hitting the top', async () => {
    const first = await today();
    expect(first.kind).toBe('ready');
    if (first.kind !== 'ready') return;
    expect(first.dayName).toBe('Push');
    expect(first.plan[0]).toMatchObject({ suggestedKg: 80, outcome: 'programme', sets: 3 });

    const push = await runDay(8);
    expect(push.summary.setsLogged).toBe(5);
    expect(push.summary.volumeKg).toBe(80 * 8 * 3 + 40 * 8 * 2);

    // Pull day is next in the same week.
    const pull = await today();
    expect(pull.kind === 'ready' && pull.dayName).toBe('Pull');
    await runDay(6);

    // Week 2, Push again: every set hit 8 → +2.5 kg.
    const next = await today();
    if (next.kind !== 'ready') throw new Error(next.kind);
    expect(next.week).toBe(2);
    expect(next.plan[0]).toMatchObject({ suggestedKg: 82.5, outcome: 'increase', repTargets: [6, 6, 6] });
    // A coach-written weight (progression defaults to prescribed) is not overridden by history.
    expect(next.plan[1]).toMatchObject({ suggestedKg: 40, outcome: 'programme' });
  });

  it('an open session is resumed instead of starting a new one', async () => {
    const t = await today();
    if (t.kind !== 'ready') throw new Error(t.kind);
    await startSession(t);
    expect((await today()).kind).toBe('in-session');
  });

  it('weight edits carry forward to later unconfirmed sets only', async () => {
    const t = await today();
    if (t.kind !== 'ready') throw new Error(t.kind);
    const s = await startSession(t);
    const work = (await sessionSets(s.id)).filter((l) => l.setType === 'straight' && l.dayExerciseId === t.plan[0].dayExerciseId).sort((a, b) => a.setIndex - b.setIndex);
    await confirmSet(work[0], null);
    await editSet(work[1], { kg: 77.5 });
    const after = (await sessionSets(s.id)).filter((l) => l.setType === 'straight' && l.dayExerciseId === t.plan[0].dayExerciseId).sort((a, b) => a.setIndex - b.setIndex);
    expect(after.map((l) => l.kg)).toEqual([80, 77.5, 77.5]);
  });

  it('deload week 4: 60% and one set fewer, no warm-ups', async () => {
    for (let week = 1; week <= 3; week++) {
      await runDay(7);
      await runDay(6);
    }
    const t = await today();
    if (t.kind !== 'ready') throw new Error(t.kind);
    expect(t.week).toBe(4);
    expect(t.isDeload).toBe(true);
    expect(t.plan[0]).toMatchObject({ outcome: 'deload', sets: 2, suggestedKg: 47.5, warmups: [] });
  });

  it('a stale session finishes at the last logged set, not "now"', async () => {
    const t = await today();
    if (t.kind !== 'ready') throw new Error(t.kind);
    const s = await startSession(t);
    const lastSetAt = s.startedAt + 40 * 60_000;
    const summary = await finishSession(s.id, lastSetAt);
    expect(summary.durationMs).toBe(40 * 60_000);
  });

  it('CSV export has one row per logged set, warm-ups marked W', async () => {
    await runDay(8);
    const csv = (await exportSetsCsv()).split('\n');
    expect(csv[0]).toBe('date,exercise,set,kg,reps,rpe,warmup');
    // Push day: 1 warm-up + 3 bench + 2 OHP = 6 rows
    expect(csv).toHaveLength(7);
    expect(csv[1]).toMatch(/,Bench Press \(Barbell\),W,40,10,,true$/);
    expect(csv.filter((l) => l.includes('Bench Press (Barbell),1,80,8'))).toHaveLength(1);
    expect(csv.filter((l) => l.includes('Overhead Press (Barbell),2,40,8'))).toHaveLength(1);
  });

  it('every write is queued for sync', async () => {
    await runDay(8);
    expect(await pendingSyncCount()).toBeGreaterThan(5);
  });
});
