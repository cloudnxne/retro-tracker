import type { RetroDB, SyncedTable } from '../db/schema';
import { CONFLICT_KEY, SERVER_TABLE, fromServer, toServer } from './mapping';

/**
 * Two-way sync between the phone's Dexie DB and Supabase.
 *
 *  [sync] ─► pull (full restore once, then incremental with a 5-min overlap)
 *        └─► push (outbox, in FK order, batches of 200)
 *              ├─ network error ─► stop, keep queue, retry later
 *              ├─ 401 ─► refresh token once ─► retry batch │ refresh failed ─► "signed-out", queue kept
 *              └─ 4xx data error ─► retry rows one by one; bad rows → deadLetters (queue never jams)
 *
 * Conflict rules on pull: programme trees + exercises are SERVER-wins (a PT's edit replaces the
 * local copy); athlete programmes, sessions, set logs and events are LOCAL-wins (a row with a
 * pending local change is not overwritten by an older server copy).
 */

/** Parents before children, so foreign keys always resolve. */
export const FK_ORDER: SyncedTable[] = [
  'exercises',
  'programmes',
  'blocks',
  'days',
  'dayExercises',
  'athleteProgrammes',
  'sessions',
  'setLogs',
  'events',
  'nutritionDays',
  'bodyweightLogs',
];
const SERVER_WINS = new Set<SyncedTable>(['exercises', 'programmes', 'blocks', 'days', 'dayExercises']);
/** Athlete-owned tables are pulled for "me" only (a PT's view of clients is the COACH phase). */
const MINE_ONLY = new Set<SyncedTable>(['athleteProgrammes', 'sessions', 'setLogs', 'events', 'nutritionDays', 'bodyweightLogs']);
/** Stable tiebreak column for paging (tables keyed by athlete + date have no id column on the server). */
const PULL_ORDER_KEY: Partial<Record<SyncedTable, string>> = { nutritionDays: 'date', bodyweightLogs: 'date' };

export const BATCH = 200;
export const PAGE = 1000;
export const OVERLAP_MS = 5 * 60_000;

export type ApiResult = { ok: true } | { ok: false; kind: 'network' | 'auth' | 'data'; status: number; message: string };

/** The only thing the engine knows about the server. Real impl: supabaseApi.ts; tests: a fake. */
export interface SyncApi {
  upsert(table: string, rows: Record<string, unknown>[], onConflict: string): Promise<ApiResult>;
  /** Rows with updated_at > since (all rows if since is null), ordered by updated_at, id; range is inclusive. */
  pull(
    table: string,
    opts: { since: string | null; from: number; to: number; ownerColumn?: string; ownerId?: string; orderKey?: string },
  ): Promise<{ ok: true; rows: Record<string, unknown>[] } | Extract<ApiResult, { ok: false }>>;
  refreshSession(): Promise<boolean>;
}

export type SyncOutcome = 'ok' | 'offline' | 'signed-out';

export class SyncEngine {
  constructor(
    private readonly db: () => RetroDB,
    private readonly api: SyncApi,
    private readonly userId: string,
  ) {}

  async sync(): Promise<SyncOutcome> {
    const pulled = await this.pull();
    if (pulled !== 'ok') return pulled;
    return this.flush();
  }

  // ─── push ───────────────────────────────────────────────────────────────────

  async flush(): Promise<SyncOutcome> {
    const d = this.db();
    const items = await d.outbox.orderBy('id').toArray();
    if (!items.length) return 'ok';
    const maxId = items[items.length - 1].id!;

    for (const table of FK_ORDER) {
      const rowIds = [...new Set(items.filter((i) => i.table === table).map((i) => i.rowId))];
      for (let i = 0; i < rowIds.length; i += BATCH) {
        const chunk = rowIds.slice(i, i + BATCH);
        const outcome = await this.pushChunk(table, chunk, maxId);
        if (outcome !== 'ok') return outcome;
      }
    }
    return 'ok';
  }

  /** Remove outbox items for these rows, but only ones read before this flush started (newer edits stay queued). */
  private async ack(table: SyncedTable, rowIds: string[], maxId: number) {
    const ids = new Set(rowIds);
    await this.db()
      .outbox.where('table')
      .equals(table)
      .filter((o) => ids.has(o.rowId) && o.id! <= maxId)
      .delete();
  }

  private async pushChunk(table: SyncedTable, rowIds: string[], maxId: number): Promise<SyncOutcome> {
    const d = this.db();
    const local = await d.table(table).bulkGet(rowIds);
    const present = rowIds.filter((_, i) => local[i] != null);
    const missing = rowIds.filter((_, i) => local[i] == null);
    if (missing.length) await this.ack(table, missing, maxId); // row gone locally: nothing to send
    if (!present.length) return 'ok';
    const rows = local.filter((r) => r != null).map((r) => toServer(table, r as Record<string, unknown>, this.userId));

    let res = await this.api.upsert(SERVER_TABLE[table], rows, CONFLICT_KEY[table]);
    if (!res.ok && res.kind === 'auth') {
      if (!(await this.api.refreshSession())) return 'signed-out';
      res = await this.api.upsert(SERVER_TABLE[table], rows, CONFLICT_KEY[table]);
    }
    if (res.ok) {
      await this.ack(table, present, maxId);
      return 'ok';
    }
    if (res.kind === 'network') return 'offline';
    if (res.kind === 'auth') return 'signed-out';

    // Data error: isolate the bad row(s) so one poison row can't jam everything behind it.
    for (let i = 0; i < rows.length; i++) {
      const one = await this.api.upsert(SERVER_TABLE[table], [rows[i]], CONFLICT_KEY[table]);
      if (one.ok) {
        await this.ack(table, [present[i]], maxId);
      } else if (one.kind === 'network') {
        return 'offline';
      } else if (one.kind === 'auth') {
        return 'signed-out';
      } else {
        await d.deadLetters.add({ table, rowId: present[i], status: one.status, message: one.message, at: Date.now() });
        await this.ack(table, [present[i]], maxId);
      }
    }
    return 'ok';
  }

  // ─── pull ───────────────────────────────────────────────────────────────────

  async pull(): Promise<SyncOutcome> {
    const d = this.db();
    const marks = ((await d.settings.get('syncWatermarks'))?.value as Record<string, string> | undefined) ?? {};

    for (const table of FK_ORDER) {
      const mark = marks[table] ?? null;
      const since = mark ? new Date(Date.parse(mark) - OVERLAP_MS).toISOString() : null;
      let newest = mark;
      for (let from = 0; ; from += PAGE) {
        const opts = {
          since,
          from,
          to: from + PAGE - 1,
          orderKey: PULL_ORDER_KEY[table] ?? 'id',
          ...(MINE_ONLY.has(table) ? { ownerColumn: ownerColumnOf(table), ownerId: this.userId } : {}),
        };
        let res = await this.api.pull(SERVER_TABLE[table], opts);
        if (!res.ok && res.kind === 'auth') {
          if (!(await this.api.refreshSession())) return 'signed-out';
          res = await this.api.pull(SERVER_TABLE[table], opts);
        }
        if (!res.ok) return res.kind === 'network' ? 'offline' : res.kind === 'auth' ? 'signed-out' : 'offline';
        await this.apply(table, res.rows);
        for (const r of res.rows) {
          const u = r.updated_at as string | undefined;
          if (u && (!newest || u > newest)) newest = u;
        }
        if (res.rows.length < PAGE) break;
      }
      if (newest) marks[table] = newest;
    }
    await d.settings.put({ key: 'syncWatermarks', value: marks });
    await d.settings.put({ key: 'restoreDone', value: true });
    return 'ok';
  }

  private async apply(table: SyncedTable, serverRows: Record<string, unknown>[]) {
    if (!serverRows.length) return;
    const d = this.db();
    await d.transaction('rw', [d.table(table), d.outbox], async () => {
      for (const sr of serverRows) {
        const row = fromServer(table, sr);
        const id = String(row.id);
        const pending = await d.outbox.where('[table+rowId]').equals([table, id]).count();
        if (pending && !SERVER_WINS.has(table)) continue; // local edit not yet pushed wins
        await d.table(table).put(row);
        if (pending) await d.outbox.where('[table+rowId]').equals([table, id]).delete(); // server wins
      }
    });
  }
}

function ownerColumnOf(table: SyncedTable) {
  return table === 'events' ? 'user_id' : 'athlete_id';
}
