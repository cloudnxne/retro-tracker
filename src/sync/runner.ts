import { useEffect, useState } from 'react';
import { currentAccount, db, isSignedIn, setQueueListener } from '../db/repo';
import { SyncEngine, type SyncOutcome } from './engine';
import { supabase, supabaseApi, syncConfigured } from './supabase';

/**
 * When to sync: on app open, when the connection comes back, a few seconds after local writes
 * (debounced), and every 2 minutes while open. One sync at a time.
 */
export type SyncStatus = 'off' | 'idle' | 'syncing' | 'offline' | 'signed-out' | 'failed';

let status: SyncStatus = 'off';
const listeners = new Set<(s: SyncStatus) => void>();
const set = (s: SyncStatus) => {
  status = s;
  listeners.forEach((l) => l(s));
};

let running: Promise<SyncOutcome> | null = null;
let debounce: number | undefined;

export async function syncNow(): Promise<SyncOutcome | null> {
  if (!syncConfigured || !isSignedIn() || !navigator.onLine) {
    if (syncConfigured && isSignedIn() && !navigator.onLine) set('offline');
    return null;
  }
  if (running) return running;
  set('syncing');
  running = supabase()
    .then((client) => new SyncEngine(db, supabaseApi(client), currentAccount()).sync())
    .then(async (outcome) => {
      const dead = await db().deadLetters.count();
      set(outcome === 'ok' ? (dead ? 'failed' : 'idle') : outcome);
      return outcome;
    })
    .catch((e) => {
      console.error('[sync]', e);
      set('failed');
      return 'offline' as SyncOutcome;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

/** Call after local writes; batches bursts (logging several sets) into one sync. */
export function scheduleSync(delayMs = 4000) {
  window.clearTimeout(debounce);
  debounce = window.setTimeout(() => void syncNow(), delayMs);
}

export function startSyncLoop() {
  if (!syncConfigured) return;
  void syncNow();
  window.addEventListener('online', () => void syncNow());
  window.addEventListener('offline', () => set('offline'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow();
  });
  window.setInterval(() => void syncNow(), 120_000);
  // Any queued write triggers a debounced sync (survives account switches: it's not tied to a DB instance).
  setQueueListener(() => scheduleSync());
}

export function useSyncStatus(): SyncStatus {
  const [s, setS] = useState(status);
  useEffect(() => {
    listeners.add(setS);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
