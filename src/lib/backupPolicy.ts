/**
 * Until cloud sync is on, the phone holds the only copy. Nudge a backup when the newest
 * backup (or, if none was ever taken, the first saved workout) is more than 7 days old.
 */
export const BACKUP_EVERY_MS = 7 * 86_400_000;
export const BACKUP_SNOOZE_MS = 2 * 86_400_000;

export function shouldNudgeBackup(s: {
  syncOn: boolean;
  /** Oldest completed workout or FUEL entry (ms); null = nothing worth backing up yet. */
  firstDataAt: number | null;
  lastBackupAt: number | null;
  snoozeUntil: number | null;
  now: number;
}): boolean {
  if (s.syncOn || s.firstDataAt == null) return false;
  if (s.snoozeUntil != null && s.now < s.snoozeUntil) return false;
  const since = s.lastBackupAt ?? s.firstDataAt;
  return s.now - since > BACKUP_EVERY_MS;
}
