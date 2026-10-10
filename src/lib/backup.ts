import { exportAll, setSetting } from '../db/repo';

export function downloadFile(name: string, type: string, body: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export const todayStamp = () => new Date().toISOString().slice(0, 10);

/** Full JSON backup (ME → Export, after an import, and the weekly nudge). Records when it was taken. */
export async function downloadBackup() {
  downloadFile(`retro-tracker-${todayStamp()}.json`, 'application/json', JSON.stringify(await exportAll(), null, 2));
  await setSetting('lastBackupAt', Date.now());
}
