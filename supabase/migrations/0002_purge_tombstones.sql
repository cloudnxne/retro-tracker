-- Decision 8: discarded sessions/sets are soft-deleted (deleted_at) so every device learns about
-- the discard on its next pull. After 30 days every device has had time to sync; purge them.
-- Needs the pg_cron extension (Supabase dashboard → Database → Extensions → pg_cron).
create extension if not exists pg_cron;

create function purge_tombstones() returns void
language sql security definer set search_path = public as $$
  delete from set_logs where deleted_at < now() - interval '30 days';
  delete from sessions where deleted_at < now() - interval '30 days';
  delete from athlete_programmes where deleted_at < now() - interval '30 days';
$$;
revoke all on function purge_tombstones() from public, anon, authenticated;

select cron.schedule('purge-tombstones', '17 3 * * *', 'select public.purge_tombstones()');
