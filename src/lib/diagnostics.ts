import { db } from '../db/repo';
import type { Diagnostic } from '../db/schema';

/**
 * In guest mode nothing leaves the phone, so errors would vanish. Keep a small local
 * trail (newest 500) that ME → "Copy diagnostics" turns into text the user can paste into a bug report.
 * Entries describe WHAT failed (action, error type, app version), never the user's numbers.
 */
export const DIAGNOSTICS_CAP = 500;
const MAX_MESSAGE = 300;

export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

/** Never throws: diagnostics must not become a second failure. */
export async function logDiagnostic(kind: Diagnostic['kind'], message: string): Promise<void> {
  try {
    const d = db();
    await d.diagnostics.add({ at: Date.now(), kind, message: message.slice(0, MAX_MESSAGE), version: APP_VERSION });
    const n = await d.diagnostics.count();
    if (n > DIAGNOSTICS_CAP) {
      const oldest = await d.diagnostics.orderBy('at').limit(n - DIAGNOSTICS_CAP).primaryKeys();
      await d.diagnostics.bulkDelete(oldest);
    }
  } catch (e) {
    console.error('[diagnostics] could not record', kind, message, e);
  }
}

/** "QuotaExceededError: …" without stack traces or row contents. */
export function errorSummary(e: unknown): string {
  const err = e as { name?: string; message?: string; inner?: { name?: string } } | null;
  const name = err?.inner?.name ?? err?.name ?? typeof e;
  const message = err?.message ?? (typeof e === 'string' ? e : '');
  return message ? `${name}: ${message}` : name;
}

/** Plain text for ME → Copy diagnostics, newest first. */
export async function diagnosticsReport(): Promise<string> {
  const rows = await db().diagnostics.orderBy('at').reverse().toArray();
  const header = [
    `Retro Tracker diagnostics · app ${APP_VERSION} · ${new Date().toISOString()}`,
    `${rows.length} entries · ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown device'}`,
  ];
  const lines = rows.map((r) => `${new Date(r.at).toISOString()} [${r.kind}] v${r.version} ${r.message}`);
  return [...header, '', ...(lines.length ? lines : ['No problems recorded.'])].join('\n');
}
