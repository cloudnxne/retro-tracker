import type { SupabaseClient } from '@supabase/supabase-js';
import type { ApiResult, SyncApi } from './engine';

/**
 * Supabase (EU region) client + the SyncApi adapter the sync engine talks to.
 * Until VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are set, the app runs fully local:
 * every write still goes into the outbox, so the first sync uploads everything.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const syncConfigured = Boolean(url && anonKey);

let _client: Promise<SupabaseClient> | null = null;
/**
 * The client library (~40 KB) is loaded only when sync is actually used, so guest mode (sync off)
 * never downloads it at the gym.
 */
export function supabase(): Promise<SupabaseClient> {
  if (!syncConfigured) return Promise.reject(new Error('Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).'));
  return (_client ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(url!, anonKey!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }),
  ));
}

/** Map a PostgREST/fetch failure onto the engine's three kinds. */
export function classify(error: { code?: string; status?: number; message?: string } | null, status: number): ApiResult {
  if (!error) return { ok: true };
  const message = error.message ?? 'unknown error';
  if (status === 0 || /fetch|network|timeout/i.test(message)) return { ok: false, kind: 'network', status: 0, message };
  if (status === 401 || error.code === 'PGRST301' || /jwt/i.test(message)) return { ok: false, kind: 'auth', status: 401, message };
  if (status >= 500) return { ok: false, kind: 'network', status, message }; // server hiccup: retry later
  return { ok: false, kind: 'data', status: status || 400, message };
}

export function supabaseApi(client: SupabaseClient): SyncApi {
  return {
    async upsert(table, rows, onConflict) {
      try {
        const { error, status } = await client.from(table).upsert(rows, { onConflict, ignoreDuplicates: false });
        return classify(error, status);
      } catch (e) {
        return { ok: false, kind: 'network', status: 0, message: String(e) };
      }
    },
    async pull(table, { since, from, to, ownerColumn, ownerId, orderKey = 'id' }) {
      try {
        let q = client.from(table).select('*').order('updated_at', { ascending: true }).order(orderKey, { ascending: true }).range(from, to);
        if (since) q = q.gt('updated_at', since);
        if (ownerColumn && ownerId) q = q.eq(ownerColumn, ownerId);
        const { data, error, status } = await q;
        const res = classify(error, status);
        return res.ok ? { ok: true as const, rows: (data ?? []) as Record<string, unknown>[] } : res;
      } catch (e) {
        return { ok: false as const, kind: 'network' as const, status: 0, message: String(e) };
      }
    },
    async refreshSession() {
      const { error } = await client.auth.refreshSession();
      return !error;
    },
  };
}

// ─── Auth (email OTP) ────────────────────────────────────────────

export async function sendCode(email: string) {
  const { error } = await (await supabase()).auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) throw error;
}

export async function verifyCode(email: string, token: string): Promise<string> {
  const { data, error } = await (await supabase()).auth.verifyOtp({ email, token, type: 'email' });
  if (error || !data.user) throw error ?? new Error('No user returned');
  return data.user.id;
}

export async function currentUserId(): Promise<string | null> {
  if (!syncConfigured) return null;
  const { data } = await (await supabase()).auth.getSession();
  return data.session?.user.id ?? null;
}

export async function signOut() {
  if (syncConfigured) await (await supabase()).auth.signOut();
}

/** Decision 4: delete the account's cloud rows + auth user via the Edge Function (service role). */
export async function deleteMyAccount(): Promise<void> {
  const { error } = await (await supabase()).functions.invoke('delete-my-account', { method: 'POST' });
  if (error) throw error;
}

/** A lifter shares their data with a PT using the PT's share code. */
export async function shareWithCoach(code: string): Promise<void> {
  const { error } = await (await supabase()).rpc('share_with_coach', { p_code: code.trim().toUpperCase() });
  if (error) throw error;
}
