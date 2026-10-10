-- RLS tests (pgTAP). Run with: supabase test db   (needs the Supabase CLI + Docker; not run yet).
-- Users: A = athlete, C = coach, X = stranger.
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@test.dev'),
  ('cccccccc-0000-0000-0000-000000000001', 'c@test.dev'),
  ('eeeeeeee-0000-0000-0000-000000000001', 'x@test.dev');

select ok((select count(*) = 3 from profiles), 'profiles created by signup trigger');

create function pg_temp.as_user(uid uuid, email text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'email', email, 'role', 'authenticated')::text, true);
  set local role authenticated;
$$;
create function pg_temp.as_admin() returns void language sql as $$ reset role; $$;

-- ── Athlete A writes their own data ──
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001', 'a@test.dev');
select lives_ok($$ insert into programmes (id, owner_id, name) values ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'A prog') $$, 'athlete creates own programme');
select lives_ok($$ insert into programme_blocks (id, owner_id, programme_id, "order", name, weeks) values ('22222222-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 0, 'B1', 3) $$, 'athlete adds block to own programme');
select throws_ok($$ insert into programmes (id, owner_id, name, is_public) values ('11111111-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001', 'spam', true) $$, '42501', null, 'users cannot publish public templates');
select lives_ok($$ insert into athlete_programmes (id, athlete_id, programme_id, started_on) values ('33333333-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', '2026-09-01') $$, 'athlete starts programme');
select lives_ok($$ insert into sessions (id, athlete_id, athlete_programme_id, day_id, week, plan_snapshot, started_at, completed_at) values ('44444444-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001', gen_random_uuid(), 1, '[]', now(), now()) $$, 'athlete logs session');
select lives_ok($$ insert into set_logs (id, athlete_id, session_id, exercise_id, set_index, set_type, kg, reps) values ('55555555-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000001', gen_random_uuid(), 0, 'straight', 100, 5) $$, 'set log accepted without exercise row (no FK, OV-3)');
select throws_ok($$ insert into sessions (id, athlete_id, athlete_programme_id, day_id, week, plan_snapshot, started_at) values (gen_random_uuid(), 'eeeeeeee-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001', gen_random_uuid(), 1, '[]', now()) $$, '42501', null, 'cannot write a session as someone else');

-- ── Coach C before any link: sees nothing, cannot self-link ──
select pg_temp.as_user('cccccccc-0000-0000-0000-000000000001', 'c@test.dev');
select is((select count(*)::int from sessions), 0, 'unlinked coach sees no sessions');
select is((select count(*)::int from programme_blocks), 0, 'unlinked coach sees no programme children');
select throws_ok($$ insert into coach_athletes (coach_id, athlete_id, status, athlete_consent_at) values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'active', now()) $$, '42501', null, 'coach cannot create a link to an athlete');
select lives_ok($$ insert into coach_share_codes (coach_id, code) values ('cccccccc-0000-0000-0000-000000000001', 'SAM-4K7') $$, 'coach sets a share code');

-- ── Athlete shares with coach by code ──
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001', 'a@test.dev');
select throws_ok($$ select share_with_coach('NOPE-000') $$, 'P0002', null, 'wrong code rejected');
select lives_ok($$ select share_with_coach('sam-4k7') $$, 'right code (any case) links coach');
select throws_ok($$ update coach_athletes set athlete_id = 'eeeeeeee-0000-0000-0000-000000000001' where coach_id = 'cccccccc-0000-0000-0000-000000000001' $$, '42501', null, 'link parties cannot be rewritten');

-- ── Linked coach reads, cannot write athlete workouts ──
select pg_temp.as_user('cccccccc-0000-0000-0000-000000000001', 'c@test.dev');
select is((select count(*)::int from sessions), 1, 'linked coach sees athlete sessions');
select is((select count(*)::int from programme_blocks), 1, 'linked coach reads athlete programme tree');
select is((select count(*)::int from set_logs where kg = 100), 1, 'linked coach reads set logs');
update set_logs set kg = 1 where id = '55555555-0000-0000-0000-000000000001';
select is((select kg from set_logs where id = '55555555-0000-0000-0000-000000000001'), 100::numeric, 'coach cannot edit athlete set logs');

-- ── Stranger X sees nothing ──
select pg_temp.as_user('eeeeeeee-0000-0000-0000-000000000001', 'x@test.dev');
select is((select count(*)::int from sessions) + (select count(*)::int from programmes) + (select count(*)::int from coach_athletes), 0, 'stranger sees nothing');

select * from finish();
rollback;
