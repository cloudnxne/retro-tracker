import { useEffect, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';
import { hasLiveSessionHere } from '../db/repo';
import { errorSummary, logDiagnostic } from './diagnostics';
import { shouldApplyUpdate, type UpdateTrigger } from './updatePolicy';

let ready = false;
let apply: ((reload?: boolean) => Promise<void>) | null = null;
const listeners = new Set<(r: boolean) => void>();
const setReady = (r: boolean) => {
  ready = r;
  listeners.forEach((l) => l(r));
};

async function tryApply(trigger: UpdateTrigger): Promise<boolean> {
  if (!apply) return false;
  if (!shouldApplyUpdate({ ready, liveSession: await hasLiveSessionHere(), trigger })) return false;
  void logDiagnostic('info', `applying update (${trigger})`);
  await apply(true);
  return true;
}

/** Service worker in "prompt" mode: the new version waits until it's safe to switch. */
export function startUpdateWatcher() {
  apply = registerSW({
    onNeedRefresh() {
      setReady(true);
    },
    onRegisterError(e: unknown) {
      void logDiagnostic('uncaught', `service worker registration: ${errorSummary(e)}`);
    },
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void tryApply('resume');
  });
}

/** ME → "Restart to update". False when a session is live (the button explains why). */
export const applyUpdateNow = () => tryApply('user');

export function useUpdateReady(): boolean {
  const [r, setR] = useState(ready);
  useEffect(() => {
    listeners.add(setR);
    return () => {
      listeners.delete(setR);
    };
  }, []);
  return r;
}
