import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { RetroDB, SCHEMA_V1, SCHEMA_V2, SYNCED_TABLES, type Session, type SetLog } from './schema';
import { db, exerciseHistory, lastTime, liftSessions, useTestDb } from './repo';
import { bestE1rm } from '../engine/e1rm';
import { FK_ORDER } from '../sync/engine';
import { DIAGNOSTICS_CAP, diagnosticsReport, errorSummary, logDiagnostic } from '../lib/diagnostics';
import { safeWrite } from '../lib/safeWrite';
import { shouldApplyUpdate } from '../lib/updatePolicy';

let n = 0;
const fresh = () => {
  const d = new RetroDB(`c3-test-${++n}`);
  useTestDb(d);
  return d;
};

const EX = 'ex-squat';
function session(id: string, at: number, extra: Partial<Session> = {}): Session {
  return {
    id, athleteProgrammeId: 'ap', dayId: 'day', week: 1, isDeload: false, startedAt: at - 3_600_000, completedAt: at,
    planSnapshot: [{ dayExerciseId: 'de', exerciseId: EX, name: 'Squat', loadType: 'barbell', sets: 2, repMin: 5, repMax: 8,
      targetRpe: 8, restSec: 120, suggestedKg: 100, repTargets: [5, 5], outcome: 'hold', reason: '', warmups: [] }],
    ...extra,
  };
}
function set(id: string, sessionId: string, i: number, kg: number | null, reps: number | null, extra: Partial<SetLog> = {}): SetLog {
  return {
    id, sessionId, exerciseId: EX, dayExerciseId: 'de', setIndex: i, setType: 'straight', plannedKg: kg, plannedReps: reps ?? 0,
    kg, reps, rpe: null, completed: true, confirmedAt: 1, ...extra,
  };
}

describe('liftSessions: one reader, every exclusion pinned', () => {
  beforeEach(async () => {
    const d = fresh();
    await d.sessions.bulkAdd([
      session('s1', 1_000_000),
      session('s2', 2_000_000, { source: 'import', planSnapshot: [] }),
      session('s3', 3_000_000, { isDeload: true }),
      session('s4', 4_000_000, { completedAt: null }), // unfinished
      session('s5', 5_000_000, { deletedAt: 9 }), // discarded
    ]);
    await d.setLogs.bulkAdd([
      set('a', 's1', 0, 100, 5),
      set('w', 's1', 1, 60, 5, { setType: 'warmup' }),
      set('del', 's1', 2, 300, 5, { deletedAt: 1 }),
      set('b', 's2', 0, 140, 3),
      set('t', 's2', 1, null, null, { sourceSetType: 'timed:45' }),
      set('c', 's3', 0, 60, 5),
      set('d', 's4', 0, 500, 5),
      set('e', 's5', 0, 500, 5),
    ]);
  });

  it('excludes warm-ups, tombstoned sets, timed sets, unfinished and discarded sessions; newest first', async () => {
    const all = await liftSessions(EX);
    expect(all.map((s) => s.sessionId)).toEqual(['s3', 's2', 's1']);
    expect(all.find((s) => s.sessionId === 's1')!.sets.map((x) => x.kg)).toEqual([100]);
    expect(all.find((s) => s.sessionId === 's2')!.sets.map((x) => x.kg)).toEqual([140]);
  });

  it('filters deloads and source on request', async () => {
    expect((await liftSessions(EX, { includeDeload: false })).map((s) => s.sessionId)).toEqual(['s2', 's1']);
    expect((await liftSessions(EX, { source: 'import' })).map((s) => s.sessionId)).toEqual(['s2']);
    expect((await liftSessions(EX, { source: 'app' })).map((s) => s.sessionId)).toEqual(['s3', 's1']);
    expect(await liftSessions(EX, { limit: 1 })).toHaveLength(1);
  });

  it('imported sessions have no prescription (never a fake 1–1 rep range)', async () => {
    const imported = (await liftSessions(EX, { source: 'import' }))[0];
    expect(imported.prescription).toBeNull();
    expect(imported.source).toBe('import');
  });

  it('progression history (exerciseHistory) never sees imports', async () => {
    const h = await exerciseHistory(EX);
    expect(h).toHaveLength(2);
    expect(h.flatMap((x) => x.sets.map((s) => s.kg))).not.toContain(140);
  });

  it('LAST TIME includes imported history (it is what you lifted)', async () => {
    await db().sessions.update('s3', { completedAt: 1 }); // make the import the newest
    expect(await lastTime(EX)).toEqual({ kg: 140, reps: 3, rpe: null });
  });
});

describe('bestE1rm', () => {
  it('takes the best completed set, honours maxReps, ignores nulls', () => {
    const sets = [
      { kg: 100, reps: 5, completed: true }, // 116.7
      { kg: 120, reps: 1, completed: true }, // 120
      { kg: 200, reps: 5, completed: false },
      { kg: null, reps: 10, completed: true },
      { kg: 80, reps: 15, completed: true }, // 120 but > 10 reps
    ];
    expect(bestE1rm(sets)).toBe(120);
    expect(bestE1rm(sets, 10)).toBe(120);
    expect(bestE1rm([{ kg: 80, reps: 15, completed: true }], 10)).toBeNull();
    expect(bestE1rm([])).toBeNull();
  });
});

describe('Dexie v3 upgrade: forward-only, additive, safe on a big history', () => {
  it('opens a v2 database with 20,000 sets and keeps every row intact', async () => {
    const name = `c3-upgrade-${++n}`;
    const v2 = new Dexie(name);
    v2.version(1).stores(SCHEMA_V1);
    v2.version(2).stores(SCHEMA_V2);
    await v2.open();
    const sessions = Array.from({ length: 1_000 }, (_, i) => session(`s${i}`, 1_000_000 + i));
    const logs = Array.from({ length: 20_000 }, (_, i) => set(`l${i}`, `s${i % 1_000}`, Math.floor(i / 1_000), 50 + (i % 100), 5));
    await v2.table('sessions').bulkAdd(sessions);
    await v2.table('setLogs').bulkAdd(logs);
    await v2.table('settings').put({ key: 'units', value: 'kg' });
    await v2.table('outbox').bulkAdd([{ table: 'setLogs', rowId: 'l1', createdAt: 1 }]);
    v2.close();

    const v3 = new RetroDB(name);
    await v3.open();
    expect(v3.verno).toBe(3);
    expect(await v3.sessions.count()).toBe(1_000);
    expect(await v3.setLogs.count()).toBe(20_000);
    expect(await v3.setLogs.get('l12345')).toEqual(logs[12345]);
    expect(await v3.settings.get('units')).toEqual({ key: 'units', value: 'kg' });
    expect(await v3.outbox.count()).toBe(1);
    expect(await v3.nutritionDays.count()).toBe(0);
    expect(await v3.diagnostics.count()).toBe(0);
    v3.close();
  }, 60_000);
});

describe('diagnostics', () => {
  beforeEach(() => {
    fresh();
  });

  it('records a failed write without throwing, and safeWrite still reports failure', async () => {
    const ok = await safeWrite('Saving test', async () => {
      throw Object.assign(new Error('disk full'), { name: 'QuotaExceededError' });
    });
    expect(ok).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    const rows = await db().diagnostics.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'write-failed', message: 'Saving test: QuotaExceededError: disk full' });
  });

  it(`keeps only the newest ${DIAGNOSTICS_CAP} entries`, async () => {
    for (let i = 0; i < DIAGNOSTICS_CAP + 5; i++) await logDiagnostic('info', `entry ${i}`);
    expect(await db().diagnostics.count()).toBe(DIAGNOSTICS_CAP);
    const report = await diagnosticsReport();
    expect(report).toContain(`entry ${DIAGNOSTICS_CAP + 4}`);
    expect(report).not.toMatch(/entry 0\b/);
  });

  it('truncates long messages and summarises errors without stacks', async () => {
    await logDiagnostic('uncaught', 'x'.repeat(1000));
    expect((await db().diagnostics.toArray())[0].message).toHaveLength(300);
    expect(errorSummary(new TypeError('bad'))).toBe('TypeError: bad');
    expect(errorSummary('plain')).toBe('string: plain');
    expect(errorSummary(null)).toBe('object');
  });

  it('says so when there is nothing to report', async () => {
    expect(await diagnosticsReport()).toContain('No problems recorded.');
  });
});

describe('update policy', () => {
  it('never applies on detection, never during a live session', () => {
    expect(shouldApplyUpdate({ ready: true, liveSession: false, trigger: 'detected' })).toBe(false);
    expect(shouldApplyUpdate({ ready: true, liveSession: true, trigger: 'resume' })).toBe(false);
    expect(shouldApplyUpdate({ ready: true, liveSession: true, trigger: 'user' })).toBe(false);
    expect(shouldApplyUpdate({ ready: false, liveSession: false, trigger: 'user' })).toBe(false);
  });
  it('applies on resume or a tap when no session is live', () => {
    expect(shouldApplyUpdate({ ready: true, liveSession: false, trigger: 'resume' })).toBe(true);
    expect(shouldApplyUpdate({ ready: true, liveSession: false, trigger: 'user' })).toBe(true);
  });
});

describe('sync coverage', () => {
  it('every synced table is in the flush/pull order (an unlisted table would never upload)', () => {
    expect([...FK_ORDER].sort()).toEqual([...SYNCED_TABLES].sort());
  });
});

describe('FUEL', () => {
  it('saves a guess with the target snapshotted, and a later target change never rewrites it', async () => {
    const { saveFuel, saveBodyweight, fuelOn, setSetting } = await import('./repo');
    fresh();
    await saveBodyweight('2026-10-01', 82.4);
    await saveFuel('2026-10-01', { proteinLevel: 'hit' });
    expect((await fuelOn('2026-10-01')).food).toMatchObject({ proteinLevel: 'hit', foodLevel: null, targetG: 130 });
    await setSetting('proteinTarget', 2.0);
    expect((await fuelOn('2026-10-01')).food?.targetG).toBe(130);
    await saveFuel('2026-10-02', { foodLevel: 'big' });
    expect((await fuelOn('2026-10-02')).food).toMatchObject({ foodLevel: 'big', targetG: 165 }); // 2.0 × 82.4
    expect(await db().outbox.where('table').equals('nutritionDays').count()).toBe(2);
  });

  it('uses the bodyweight on or before that day, never a later one', async () => {
    const { saveFuel, saveBodyweight, fuelOn } = await import('./repo');
    fresh();
    await saveBodyweight('2026-09-01', 80);
    await saveBodyweight('2026-10-01', 90);
    await saveFuel('2026-09-15', { proteinLevel: 'under' });
    expect((await fuelOn('2026-09-15')).food?.targetG).toBe(130); // 1.6 × 80 = 128 → 130
  });

  it('no bodyweight yet → no target, still saves the guess', async () => {
    const { saveFuel, fuelOn } = await import('./repo');
    fresh();
    await saveFuel('2026-10-01', { proteinLevel: 'over' });
    expect((await fuelOn('2026-10-01')).food).toMatchObject({ proteinLevel: 'over', targetG: null });
  });

  it('editing one field keeps the other', async () => {
    const { saveFuel, fuelOn } = await import('./repo');
    fresh();
    await saveFuel('2026-10-01', { proteinLevel: 'hit', foodLevel: 'normal' });
    await saveFuel('2026-10-01', { foodLevel: 'big' });
    expect((await fuelOn('2026-10-01')).food).toMatchObject({ proteinLevel: 'hit', foodLevel: 'big' });
  });

  it('rejects an impossible bodyweight', async () => {
    const { saveBodyweight } = await import('./repo');
    fresh();
    await expect(saveBodyweight('2026-10-01', 8)).rejects.toThrow(RangeError);
  });
});
