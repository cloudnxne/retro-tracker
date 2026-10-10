import type { ApiResult, SyncApi } from './engine';

/**
 * In-memory stand-in for Supabase/PostgREST used by the sync tests. It enforces the same
 * foreign keys as supabase/migrations/0001_init.sql, stamps updated_at with its own clock
 * (like the server trigger), rejects a whole batch on any bad row (like PostgREST), and can
 * simulate going offline, an expired token, and poison rows.
 */
/**
 * Exactly the foreign keys in supabase/migrations/0001_init.sql, no more. Athlete data does NOT
 * reference the programme tree (a coach deleting a programme must not touch history; imported
 * history uses placeholder ids), so the fake must not enforce those either.
 */
const FKS: Record<string, [string, string][]> = {
  programme_blocks: [['programme_id', 'programmes']],
  programme_days: [['programme_id', 'programmes'], ['block_id', 'programme_blocks']],
  programme_exercises: [['day_id', 'programme_days'], ['programme_id', 'programmes']],
  sessions: [['athlete_programme_id', 'athlete_programmes']],
  set_logs: [['session_id', 'sessions']],
};

export class FakeSupabase implements SyncApi {
  tables = new Map<string, Map<string, Record<string, unknown>>>();
  calls: { op: 'upsert' | 'pull'; table: string; rows?: number }[] = [];
  offline = false;
  /** Go offline after this many successful upserts (network drop mid-flush). */
  dropAfter: number | null = null;
  tokenExpired = false;
  refreshWorks = true;
  poison: (table: string, row: Record<string, unknown>) => string | null = () => null;
  private clock = Date.parse('2026-09-27T10:00:00Z');
  private upserts = 0;

  table(name: string) {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name)!;
  }
  rows(name: string) {
    return [...this.table(name).values()];
  }
  /** Simulate a server-side write, e.g. a PT editing a programme, with an optional explicit updated_at. */
  serverWrite(name: string, row: Record<string, unknown>, key = 'id', updatedAt?: string) {
    this.table(name).set(String(row[key]), { ...row, updated_at: updatedAt ?? this.tick() });
  }
  private tick() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  async upsert(table: string, rows: Record<string, unknown>[], onConflict: string): Promise<ApiResult> {
    this.calls.push({ op: 'upsert', table, rows: rows.length });
    if (this.offline || (this.dropAfter != null && this.upserts >= this.dropAfter)) {
      return { ok: false, kind: 'network', status: 0, message: 'Failed to fetch' };
    }
    if (this.tokenExpired) return { ok: false, kind: 'auth', status: 401, message: 'JWT expired' };
    for (const r of rows) {
      for (const [col, parent] of FKS[table] ?? []) {
        if (r[col] != null && !this.table(parent).has(String(r[col]))) {
          return { ok: false, kind: 'data', status: 409, message: `violates foreign key ${table}.${col} → ${parent}` };
        }
      }
      const bad = this.poison(table, r);
      if (bad) return { ok: false, kind: 'data', status: 400, message: bad };
    }
    const keys = onConflict.split(',');
    // Key = the conflict columns ("id", or "owner_id|id" for exercises), like the real upsert.
    for (const r of rows) this.table(table).set(keys.map((k) => String(r[k])).join('|'), { ...r, updated_at: this.tick() });
    this.upserts++;
    return { ok: true };
  }

  async pull(table: string, opts: { since: string | null; from: number; to: number; ownerColumn?: string; ownerId?: string; orderKey?: string }) {
    const key = opts.orderKey ?? 'id';
    this.calls.push({ op: 'pull', table });
    if (this.offline) return { ok: false as const, kind: 'network' as const, status: 0, message: 'Failed to fetch' };
    if (this.tokenExpired) return { ok: false as const, kind: 'auth' as const, status: 401, message: 'JWT expired' };
    const rows = this.rows(table)
      .filter((r) => !opts.since || (r.updated_at as string) > opts.since)
      .filter((r) => !opts.ownerColumn || r[opts.ownerColumn] === opts.ownerId)
      .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)) || String(a[key]).localeCompare(String(b[key])))
      .slice(opts.from, opts.to + 1);
    return { ok: true as const, rows };
  }

  async refreshSession() {
    if (!this.refreshWorks) return false;
    this.tokenExpired = false;
    return true;
  }
}
