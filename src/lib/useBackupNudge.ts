import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSetting, isSignedIn, setSetting } from '../db/repo';
import { syncConfigured } from '../sync/supabase';
import { BACKUP_SNOOZE_MS, shouldNudgeBackup } from './backupPolicy';

/** TODAY asks for a backup when the phone has held the only copy for over a week. */
export function useBackupNudge() {
  const due = useLiveQuery(async () => {
    const firstSession = await db().sessions.orderBy('completedAt').first();
    const firstFuel = await db().nutritionDays.orderBy('id').first();
    const candidates = [firstSession?.completedAt, firstFuel ? Date.parse(firstFuel.id) : null].filter((x): x is number => x != null);
    return shouldNudgeBackup({
      syncOn: syncConfigured && isSignedIn(),
      firstDataAt: candidates.length ? Math.min(...candidates) : null,
      lastBackupAt: await getSetting<number | null>('lastBackupAt', null),
      snoozeUntil: await getSetting<number | null>('backupSnoozeUntil', null),
      now: Date.now(),
    });
  }, []);
  return { due: !!due, snooze: () => setSetting('backupSnoozeUntil', Date.now() + BACKUP_SNOOZE_MS) };
}
