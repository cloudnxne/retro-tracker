import { errorSummary, logDiagnostic } from './diagnostics';

/**
 * A failed write must never look like a saved one.
 * Every UI write goes through safeWrite(); on failure it tells the user what didn't save and
 * offers TRY AGAIN (re-runs the same action), and returns false so the caller doesn't advance.
 */
export interface WriteFailure {
  label: string;
  message: string;
  retry: () => Promise<boolean>;
}

type Listener = (f: WriteFailure | null) => void;
const listeners = new Set<Listener>();

export function onWriteFailure(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
const emit = (f: WriteFailure | null) => listeners.forEach((l) => l(f));

/** Plain-English reason for the common IndexedDB failures on phones. */
export function describeWriteError(e: unknown): string {
  const name = (e as { name?: string; inner?: { name?: string } })?.inner?.name ?? (e as { name?: string })?.name ?? '';
  if (name === 'QuotaExceededError') return 'phone storage is full';
  if (name === 'InvalidStateError' || name === 'DatabaseClosedError' || name === 'SecurityError' || name === 'MissingAPIError') {
    return 'phone storage is blocked (private browsing?)';
  }
  return 'something went wrong';
}

export async function safeWrite(label: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    emit(null);
    return true;
  } catch (e) {
    console.error(`[safeWrite] ${label} failed`, e);
    void logDiagnostic('write-failed', `${label}: ${errorSummary(e)}`);
    emit({ label, message: describeWriteError(e), retry: () => safeWrite(label, fn) });
    return false;
  }
}

/** Safety net for anything that escaped safeWrite. */
export function installGlobalWriteErrorHandler() {
  window.addEventListener('unhandledrejection', (ev) => {
    console.error('[unhandledrejection]', ev.reason);
    void logDiagnostic('uncaught', `unhandled promise: ${errorSummary(ev.reason)}`);
    emit({ label: 'That change', message: describeWriteError(ev.reason), retry: async () => false });
  });
  window.addEventListener('error', (ev) => {
    void logDiagnostic('uncaught', `${errorSummary(ev.error ?? ev.message)} at ${ev.filename?.split('/').pop() ?? '?'}:${ev.lineno ?? '?'}`);
  });
}
