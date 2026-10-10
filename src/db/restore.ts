import { BACKUP_FORMAT, currentAccount, db, isSignedIn, queue } from './repo';
import { SYNCED_TABLES, type SyncedTable } from './schema';

/**
 * Restore from a JSON backup: REPLACE-ALL in one transaction.
 *   validate ─▶ preview counts ─▶ confirm (if this phone has data) ─▶ wipe + write + re-queue
 * A failure anywhere leaves the phone exactly as it was.
 */

/** Settings that belong to this phone's sync state, not to the backed-up data. Never restored. */
const LOCAL_ONLY_SETTINGS = new Set(['syncWatermarks', 'restoreDone', 'ownerId', 'email', 'signInSkipped']);

export class BackupError extends Error {}

export interface RestorePreview {
  exportedAt: string | null;
  version: number | null;
  counts: Partial<Record<SyncedTable, number>>;
  /** This phone already has workouts or a programme: restoring replaces them. */
  replacesData: boolean;
  data: Record<string, Record<string, unknown>[]>;
}

const damaged = (t: string) => new BackupError(`The backup's "${t}" section is damaged.`);

export async function previewRestore(json: unknown): Promise<RestorePreview> {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new BackupError("This isn't a Retro Tracker backup.");
  const o = json as Record<string, unknown>;
  // Backups from before the format marker existed still have settings + sessions arrays.
  const looksLikeBackup = o.format === BACKUP_FORMAT || (Array.isArray(o.settings) && Array.isArray(o.sessions));
  if (!looksLikeBackup) throw new BackupError("This isn't a Retro Tracker backup.");
  const version = typeof o.version === 'number' ? o.version : null;
  if (version != null && version > db().verno) {
    throw new BackupError('This backup was made by a newer version of the app. Update the app, then restore.');
  }
  const data: RestorePreview['data'] = {};
  const counts: RestorePreview['counts'] = {};
  for (const t of ['settings', ...SYNCED_TABLES] as const) {
    const rows = o[t] ?? [];
    if (!Array.isArray(rows) || rows.some((r) => !r || typeof r !== 'object')) throw damaged(t);
    if (t === 'settings' ? rows.some((r) => typeof r.key !== 'string') : rows.some((r) => typeof r.id !== 'string')) throw damaged(t);
    data[t] = rows as Record<string, unknown>[];
    if (t !== 'settings') counts[t] = rows.length;
  }
  const d = db();
  const replacesData = (await d.sessions.count()) + (await d.programmes.count()) > 0;
  return { exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : null, version, counts, replacesData, data };
}

export async function restoreBackup(p: RestorePreview): Promise<{ rows: number }> {
  const d = db();
  const signedIn = isSignedIn();
  const account = currentAccount();
  let rows = 0;
  await d.transaction('rw', [...SYNCED_TABLES.map((t) => d.table(t)), d.settings, d.outbox, d.deadLetters, d.timers], async () => {
    for (const t of SYNCED_TABLES) await d.table(t).clear();
    await d.outbox.clear();
    await d.deadLetters.clear();
    await d.timers.clear();
    const keepLocal = (await d.settings.toArray()).filter((s) => LOCAL_ONLY_SETTINGS.has(s.key));
    await d.settings.clear();
    const restored = p.data.settings.filter((s) => !LOCAL_ONLY_SETTINGS.has(String(s.key)));
    await d.settings.bulkPut([...restored, ...keepLocal] as never[]);
    for (const t of SYNCED_TABLES) {
      // Rows belong to whoever restores them: stamped now if signed in, at claim time if guest.
      const list = p.data[t].map(({ ownerId: _old, ...rest }) => (signedIn ? { ...rest, ownerId: account } : rest));
      if (!list.length) continue;
      await d.table(t).bulkPut(list);
      await queue(t, ...list.map((r) => String(r.id)));
      rows += list.length;
    }
  });
  return { rows };
}
