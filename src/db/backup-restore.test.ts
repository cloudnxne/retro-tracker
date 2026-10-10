import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import text from '../import/fixtures/strong-sample.csv?raw';
import { parseCsv } from '../import/csv';
import { parseStrong } from '../import/strong';
import { RetroDB, SYNCED_TABLES } from './schema';
import { BACKUP_FORMAT, confirmSet, db, exportAll, finishSession, importProgramme, sessionSets, setSetting, startSession, today, useTestDb } from './repo';
import { commitImport, previewImport } from './importHistory';
import { BackupError, previewRestore, restoreBackup } from './restore';
import { STARTER } from '../data/starter';
import { BACKUP_EVERY_MS, shouldNudgeBackup } from '../lib/backupPolicy';

let n = 0;
const fresh = () => {
  const d = new RetroDB(`backup-test-${++n}`);
  useTestDb(d);
  return d;
};

/** A phone with a programme, one logged workout, imported history and FUEL data. */
async function populated() {
  fresh();
  await importProgramme(STARTER);
  const t = await today();
  if (t.kind !== 'ready') throw new Error(t.kind);
  const s = await startSession(t);
  for (const l of await sessionSets(s.id)) await confirmSet({ ...l, kg: l.kg ?? 40 }, null);
  await finishSession(s.id);
  await commitImport(await previewImport(parseStrong(await parseCsv(text), 'kg')));
  await db().nutritionDays.put({ id: '2026-09-30', protein: 160, kcal: 2500, targetG: 150, updatedAt: 1 });
  await db().bodyweightLogs.put({ id: '2026-10-01', kg: 82, updatedAt: 1 });
  await setSetting('units', 'kg');
}

async function snapshot() {
  const out: Record<string, unknown[]> = {};
  for (const t of SYNCED_TABLES) out[t] = (await db().table(t).toArray()).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return out;
}

describe('restore round trip', () => {
  it('export → wipe → restore gives identical rows in every synced table', async () => {
    await populated();
    const before = await snapshot();
    const backup = JSON.parse(JSON.stringify(await exportAll()));
    expect(backup).toMatchObject({ format: BACKUP_FORMAT, version: 3 });

    fresh(); // a wiped (or new) phone
    const p = await previewRestore(backup);
    expect(p.replacesData).toBe(false);
    expect(p.counts.setLogs).toBe(before.setLogs.length);
    await restoreBackup(p);
    expect(await snapshot()).toEqual(before);
    // Everything is queued again so sync (when on) uploads the restored data.
    expect(await db().outbox.count()).toBe(Object.values(before).reduce((x, rows) => x + rows.length, 0));
  });

  it('replaces whatever was on the phone (replace-all, not merge)', async () => {
    await populated();
    const backup = JSON.parse(JSON.stringify(await exportAll()));
    fresh();
    await importProgramme({ ...STARTER, name: 'Something else' });
    const p = await previewRestore(backup);
    expect(p.replacesData).toBe(true);
    await restoreBackup(p);
    expect((await db().programmes.toArray()).map((x) => x.name)).toEqual([STARTER.name]);
  });

  it("keeps this phone's sync settings and drops the backup's", async () => {
    await populated();
    await setSetting('syncWatermarks', { sessions: 'old' });
    const backup = JSON.parse(JSON.stringify(await exportAll()));
    fresh();
    await setSetting('syncWatermarks', { sessions: 'mine' });
    await restoreBackup(await previewRestore(backup));
    expect((await db().settings.get('syncWatermarks'))?.value).toEqual({ sessions: 'mine' });
    expect((await db().settings.get('units'))?.value).toBe('kg');
  });

  it('a failure part-way leaves the phone exactly as it was', async () => {
    await populated();
    const backup = JSON.parse(JSON.stringify(await exportAll()));
    fresh();
    await importProgramme({ ...STARTER, name: 'Keep me' });
    const before = await snapshot();
    const p = await previewRestore(backup);
    // Fail the set-log write wherever it's reached from (db.setLogs or db.table('setLogs')).
    const proto = Object.getPrototypeOf(db().setLogs) as { bulkPut: (...a: unknown[]) => Promise<unknown> };
    const original = proto.bulkPut;
    proto.bulkPut = function (this: { name: string }, ...args: unknown[]) {
      return this.name === 'setLogs' ? Promise.reject(new Error('disk full')) : original.apply(this, args);
    };
    try {
      await expect(restoreBackup(p)).rejects.toThrow('disk full');
    } finally {
      proto.bulkPut = original;
    }
    expect(await snapshot()).toEqual(before);
  });
});

describe('previewRestore refuses bad files with a named reason', () => {
  beforeEach(() => {
    fresh();
  });
  it.each([
    [null, "This isn't a Retro Tracker backup."],
    [[], "This isn't a Retro Tracker backup."],
    [{ hello: 'world' }, "This isn't a Retro Tracker backup."],
    [{ format: BACKUP_FORMAT, version: 99, settings: [], sessions: [] }, 'This backup was made by a newer version of the app. Update the app, then restore.'],
    [{ format: BACKUP_FORMAT, version: 3, settings: [], sessions: [{ nope: 1 }] }, 'The backup\'s "sessions" section is damaged.'],
    [{ format: BACKUP_FORMAT, version: 3, settings: [{ value: 1 }], sessions: [] }, 'The backup\'s "settings" section is damaged.'],
  ])('%j', async (json, message) => {
    await expect(previewRestore(json)).rejects.toThrow(new BackupError(message));
  });
  it('accepts backups made before the format marker existed', async () => {
    const p = await previewRestore({ exportedAt: '2026-09-01T00:00:00Z', settings: [], sessions: [] });
    expect(p.version).toBeNull();
  });
});

describe('backup nudge', () => {
  const now = 100 * 86_400_000;
  const base = { syncOn: false, firstDataAt: now - 30 * 86_400_000, lastBackupAt: null, snoozeUntil: null, now };
  it('nudges when the only copy is over a week old', () => {
    expect(shouldNudgeBackup(base)).toBe(true);
    expect(shouldNudgeBackup({ ...base, lastBackupAt: now - BACKUP_EVERY_MS - 1 })).toBe(true);
  });
  it('stays quiet when sync is on, there is no data, a recent backup exists, or it was snoozed', () => {
    expect(shouldNudgeBackup({ ...base, syncOn: true })).toBe(false);
    expect(shouldNudgeBackup({ ...base, firstDataAt: null })).toBe(false);
    expect(shouldNudgeBackup({ ...base, lastBackupAt: now - BACKUP_EVERY_MS })).toBe(false);
    expect(shouldNudgeBackup({ ...base, firstDataAt: now - 86_400_000 })).toBe(false);
    expect(shouldNudgeBackup({ ...base, snoozeUntil: now + 1 })).toBe(false);
  });
});
