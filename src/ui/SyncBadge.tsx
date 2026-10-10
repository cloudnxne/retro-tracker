import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { pendingSyncCount } from '../db/repo';
import { syncNow, useSyncStatus } from '../sync/runner';

/**
 * Sync badge: quiet when all is well. Offline → "3 saved on phone". Signed out → "Sign in to sync".
 * A row the server rejected → amber "Couldn't sync. Tap to retry". Never blocks logging.
 */
export function SyncBadge() {
  const status = useSyncStatus();
  const pending = useLiveQuery(pendingSyncCount, []) ?? 0;
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  if (status === 'failed') {
    return (
      <button className="sync fail" onClick={() => void syncNow()} aria-label="Some changes couldn't sync. Tap to retry">
        ⚠ Couldn't sync. Tap to retry
      </button>
    );
  }
  if (status === 'signed-out') {
    return <span className="sync fail">Sign in to sync</span>;
  }
  if ((!online || status === 'offline') && pending) {
    return (
      <button
        className="sync"
        onClick={() => window.alert("They'll sync when you're back online. Nothing is lost.")}
        aria-label={`${pending} changes saved on this phone, waiting for signal`}
      >
        <span aria-hidden="true">☁︎⃠</span> {pending} saved on phone
      </button>
    );
  }
  return null;
}
