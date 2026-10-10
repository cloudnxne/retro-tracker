-- Retro Tracker: initial schema (run in a Supabase project, EU region).
-- Mirrors src/db/schema.ts via src/sync/mapping.ts: every column the client sends is listed there.
-- Every id is a client-generated UUID so offline replays are idempotent upserts.
--
-- Deliberate deviations from a "textbook" schema:
--   * No FK from set_logs / programme_exercises to exercises. Exercise ids are name-derived uuidv5
--, shared across users, and exercises are keyed (owner_id, id). A set must never be
--     rejected because the exercise row hasn't synced yet.
--   * No FK from athlete data (athlete_programmes, sessions, set_logs) into the programme tree.
--     Programmes are often owned by the coach; deleting a coach account must not delete or block
--     the athlete's history. The session keeps its own plan_snapshot.
--   * No unique (athlete, week, day) index on sessions: two offline devices may both log the same
--     day, and both workouts are real. The client derives position from completed sessions.

-- ── Profiles (one per auth user, created automatically) ─────────────────────────
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  role text not null default 'athlete' check (role in ('athlete', 'coach')),
  display_name text,
  units text not null default 'kg' check (units in ('kg', 'lb')),
  consent_at timestamptz,
  updated_at timestamptz not null default now()
);

create function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id) values (new.id) on conflict do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- ── Coach links (the ATHLETE creates the link with the coach's share code) ──
create table coach_share_codes (
  coach_id uuid primary key references profiles on delete cascade,
  code text not null unique check (code ~ '^[A-Z0-9-]{6,12}$'),
  created_at timestamptz not null default now()
);

create table coach_athletes (
  coach_id uuid not null references profiles on delete cascade,
  athlete_id uuid not null references profiles on delete cascade,
  status text not null default 'active' check (status in ('active', 'ended')),
  -- Explicit consent before a coach sees training/health data (privacy requirement).
  athlete_consent_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (coach_id, athlete_id),
  check (coach_id <> athlete_id)
);

-- A coach asking an athlete to share (the athlete still acts via share_with_coach).
create table coach_requests (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references profiles on delete cascade,
  athlete_email text not null,
  created_at timestamptz not null default now(),
  unique (coach_id, athlete_email)
);

-- ── Training data ─────────────────────────────────────────────────────────────
create table exercises (
  owner_id uuid not null references profiles on delete cascade,
  id uuid not null,
  name text not null,
  load_type text not null check (load_type in ('barbell', 'dumbbell', 'machine', 'bodyweight')),
  load_increment numeric check (load_increment is null or load_increment > 0),
  bar_weight numeric check (bar_weight is null or bar_weight >= 0),
  swap_group text,
  how_to text,
  updated_at timestamptz not null default now(),
  primary key (owner_id, id)
);

create table programmes (
  id uuid primary key,
  owner_id uuid not null references profiles on delete cascade,
  name text not null,
  is_template boolean not null default false,
  -- Only the curated library sets this (service role); users cannot publish (see policy).
  is_public boolean not null default false,
  deload_every int not null default 4 check (deload_every between 0 and 52),
  updated_at timestamptz not null default now()
);

create table programme_blocks (
  id uuid primary key,
  owner_id uuid not null references profiles on delete cascade,
  programme_id uuid not null references programmes on delete cascade,
  "order" int not null,
  name text not null,
  weeks int not null check (weeks between 1 and 52),
  updated_at timestamptz not null default now()
);

create table programme_days (
  id uuid primary key,
  owner_id uuid not null references profiles on delete cascade,
  programme_id uuid not null references programmes on delete cascade,
  block_id uuid not null references programme_blocks on delete cascade,
  "order" int not null,
  name text not null,
  updated_at timestamptz not null default now()
);

create table programme_exercises (
  id uuid primary key,
  owner_id uuid not null references profiles on delete cascade,
  programme_id uuid not null references programmes on delete cascade,
  day_id uuid not null references programme_days on delete cascade,
  exercise_id uuid not null,
  "order" int not null,
  sets int not null check (sets between 1 and 20),
  rep_min int not null check (rep_min >= 1),
  rep_max int not null check (rep_max <= 100),
  target_rpe numeric check (target_rpe is null or target_rpe between 5 and 10),
  rest_sec int not null default 120 check (rest_sec between 0 and 900),
  prescribed_kg numeric check (prescribed_kg is null or prescribed_kg >= 0),
  progression text not null default 'auto' check (progression in ('auto', 'prescribed')),
  warmups jsonb not null default '[]' check (jsonb_typeof(warmups) = 'array'),
  cue text,
  source_set_type text,
  updated_at timestamptz not null default now(),
  check (rep_min <= rep_max)
);

create table athlete_programmes (
  id uuid primary key,
  athlete_id uuid not null references profiles on delete cascade,
  programme_id uuid not null, -- no FK: see header
  started_on date not null,
  deload_anchor_week int not null default 0,
  status text not null default 'active' check (status in ('active', 'paused', 'done')),
  deleted_at timestamptz,
  updated_at timestamptz not null default now()
);

create table sessions (
  id uuid primary key,
  athlete_id uuid not null references profiles on delete cascade,
  athlete_programme_id uuid not null references athlete_programmes on delete cascade,
  day_id uuid not null, -- no FK: see header
  week int not null check (week >= 1),
  is_deload boolean not null default false,
  plan_snapshot jsonb not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  device_id text,
  deleted_at timestamptz,
  updated_at timestamptz not null default now()
);

create table set_logs (
  id uuid primary key,
  athlete_id uuid not null references profiles on delete cascade,
  session_id uuid not null references sessions on delete cascade,
  exercise_id uuid not null,
  programme_exercise_id uuid,
  set_index int not null check (set_index >= 0),
  set_type text not null check (set_type in ('warmup', 'straight')),
  planned_kg numeric,
  planned_reps int,
  kg numeric check (kg is null or kg between 0 and 1000),
  reps int check (reps is null or reps between 0 and 200),
  rpe numeric check (rpe is null or rpe between 1 and 10),
  completed boolean not null default false,
  confirmed_at timestamptz,
  deleted_at timestamptz,
  updated_at timestamptz not null default now()
);

create table events (
  id uuid primary key,
  user_id uuid not null references profiles on delete cascade,
  name text not null,
  ts timestamptz not null,
  payload jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- ── updated_at is server-owned: it drives incremental pulls (watermark + 5 min overlap) ──
create function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['profiles','coach_athletes','exercises','programmes','programme_blocks','programme_days',
                           'programme_exercises','athlete_programmes','sessions','set_logs','events'] loop
    execute format('create trigger touch before insert or update on %I for each row execute function touch_updated_at()', t);
  end loop;
end;
$$;

-- ── Indexes for pulls (owner filter + updated_at order) and history lookups ────
create index exercises_pull on exercises (owner_id, updated_at, id);
create index programmes_pull on programmes (owner_id, updated_at, id);
create index blocks_pull on programme_blocks (programme_id, updated_at, id);
create index days_pull on programme_days (programme_id, updated_at, id);
create index pex_pull on programme_exercises (programme_id, updated_at, id);
create index blocks_owner on programme_blocks (owner_id, updated_at);
create index days_owner on programme_days (owner_id, updated_at);
create index pex_owner on programme_exercises (owner_id, updated_at);
create index ap_pull on athlete_programmes (athlete_id, updated_at, id);
create index ap_programme on athlete_programmes (programme_id);
create index sessions_pull on sessions (athlete_id, updated_at, id);
create index set_logs_pull on set_logs (athlete_id, updated_at, id);
create index set_logs_session on set_logs (session_id);
create index set_logs_exercise on set_logs (athlete_id, exercise_id, confirmed_at desc);
create index events_pull on events (user_id, updated_at, id);
create index coach_athletes_athlete on coach_athletes (athlete_id);

-- ── Row Level Security ────────────────────────────────────────────────────────
alter table profiles enable row level security;
alter table coach_share_codes enable row level security;
alter table coach_athletes enable row level security;
alter table coach_requests enable row level security;
alter table exercises enable row level security;
alter table programmes enable row level security;
alter table programme_blocks enable row level security;
alter table programme_days enable row level security;
alter table programme_exercises enable row level security;
alter table athlete_programmes enable row level security;
alter table sessions enable row level security;
alter table set_logs enable row level security;
alter table events enable row level security;

-- Helpers are SECURITY DEFINER so policies don't recurse through each other's RLS.

-- The caller coaches `athlete` (active link + the athlete's consent).
create function is_coach_of(athlete uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from coach_athletes
    where coach_id = auth.uid() and athlete_id = athlete
      and status = 'active' and athlete_consent_at is not null
  );
$$;

-- `coach` coaches the caller.
create function is_my_coach(coach uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from coach_athletes
    where coach_id = coach and athlete_id = auth.uid()
      and status = 'active' and athlete_consent_at is not null
  );
$$;

-- Who may READ a programme tree: its owner, anyone for curated public templates, the athlete
-- it's assigned to, the owner's coach, and the coach of an athlete running it.
create function can_read_programme(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from programmes p
    where p.id = pid and (p.owner_id = auth.uid() or p.is_public or is_coach_of(p.owner_id))
  ) or exists (
    select 1 from athlete_programmes ap
    where ap.programme_id = pid and ap.deleted_at is null
      and (ap.athlete_id = auth.uid() or is_coach_of(ap.athlete_id))
  );
$$;

-- Who may WRITE a programme tree: only its owner.
create function owns_programme(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from programmes p where p.id = pid and p.owner_id = auth.uid());
$$;

-- Profiles
create policy "own profile" on profiles for all using (id = auth.uid()) with check (id = auth.uid());
create policy "coach reads linked athlete profile" on profiles for select using (is_coach_of(id));
create policy "athlete reads own coach profile" on profiles for select using (is_my_coach(id));

-- Share codes: a coach manages their own; nobody lists codes (lookup is via share_with_coach only).
create policy "coach owns code" on coach_share_codes for all
  using (coach_id = auth.uid()) with check (coach_id = auth.uid());

-- Coach links: both parties read; ONLY the athlete creates or changes a link.
create policy "link parties read" on coach_athletes for select
  using (coach_id = auth.uid() or athlete_id = auth.uid());
create policy "athlete creates link" on coach_athletes for insert
  with check (athlete_id = auth.uid());
create policy "athlete consents or ends" on coach_athletes for update
  using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());
create policy "either party removes link" on coach_athletes for delete
  using (coach_id = auth.uid() or athlete_id = auth.uid());

-- The link's parties can never be rewritten (turning someone else's link into yours).
create function coach_link_immutable() returns trigger
language plpgsql as $$
begin
  if new.coach_id <> old.coach_id or new.athlete_id <> old.athlete_id then
    raise exception 'coach_athletes: coach_id and athlete_id cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger coach_link_immutable before update on coach_athletes for each row execute function coach_link_immutable();

-- Coach requests: the coach manages theirs; the athlete sees requests sent to their email.
create policy "coach manages requests" on coach_requests for all
  using (coach_id = auth.uid()) with check (coach_id = auth.uid());
create policy "athlete sees requests to me" on coach_requests for select
  using (lower(athlete_email) = lower(coalesce(auth.jwt() ->> 'email', '')));
create policy "athlete dismisses requests to me" on coach_requests for delete
  using (lower(athlete_email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- The athlete types the coach's code; this creates an active, consented link.
create function share_with_coach(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_coach uuid;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select coach_id into v_coach from coach_share_codes where code = upper(trim(p_code));
  if v_coach is null then
    raise exception 'unknown code' using errcode = 'P0002';
  end if;
  if v_coach = auth.uid() then
    raise exception 'cannot coach yourself' using errcode = '22023';
  end if;
  insert into coach_athletes (coach_id, athlete_id, status, athlete_consent_at)
  values (v_coach, auth.uid(), 'active', now())
  on conflict (coach_id, athlete_id) do update set status = 'active', athlete_consent_at = now();
  delete from coach_requests where coach_id = v_coach
    and lower(athlete_email) = lower(coalesce(auth.jwt() ->> 'email', ''));
  return v_coach;
end;
$$;
revoke all on function share_with_coach(text) from public, anon;
grant execute on function share_with_coach(text) to authenticated;

-- Exercises: own rows; coach and athlete can read each other's (shared name-derived ids).
create policy "own exercises" on exercises for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "linked exercises readable" on exercises for select
  using (is_coach_of(owner_id) or is_my_coach(owner_id));

-- Programmes: owner writes (never publishes); readers per can_read_programme.
create policy "read programmes" on programmes for select using (can_read_programme(id));
create policy "insert own programmes" on programmes for insert
  with check (owner_id = auth.uid() and not is_public);
create policy "update own programmes" on programmes for update
  using (owner_id = auth.uid()) with check (owner_id = auth.uid() and not is_public);
create policy "delete own programmes" on programmes for delete using (owner_id = auth.uid());

-- Programme children: split read / write. Writes need the row AND the parent to be yours.
create policy "read blocks" on programme_blocks for select using (can_read_programme(programme_id));
create policy "write blocks" on programme_blocks for insert
  with check (owner_id = auth.uid() and owns_programme(programme_id));
create policy "update blocks" on programme_blocks for update
  using (owner_id = auth.uid()) with check (owner_id = auth.uid() and owns_programme(programme_id));
create policy "delete blocks" on programme_blocks for delete using (owner_id = auth.uid());

create policy "read days" on programme_days for select using (can_read_programme(programme_id));
create policy "write days" on programme_days for insert
  with check (owner_id = auth.uid() and owns_programme(programme_id));
create policy "update days" on programme_days for update
  using (owner_id = auth.uid()) with check (owner_id = auth.uid() and owns_programme(programme_id));
create policy "delete days" on programme_days for delete using (owner_id = auth.uid());

create policy "read programme exercises" on programme_exercises for select using (can_read_programme(programme_id));
create policy "write programme exercises" on programme_exercises for insert
  with check (owner_id = auth.uid() and owns_programme(programme_id));
create policy "update programme exercises" on programme_exercises for update
  using (owner_id = auth.uid()) with check (owner_id = auth.uid() and owns_programme(programme_id));
create policy "delete programme exercises" on programme_exercises for delete using (owner_id = auth.uid());

-- Athlete programmes: athlete writes; their coach can read and assign/adjust.
create policy "athlete or coach" on athlete_programmes for all
  using (athlete_id = auth.uid() or is_coach_of(athlete_id))
  with check (athlete_id = auth.uid() or is_coach_of(athlete_id));

-- Workouts: the athlete writes; the coach reads (decision: completed workouts visible on any device).
create policy "athlete writes sessions" on sessions for all
  using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());
create policy "coach reads sessions" on sessions for select using (is_coach_of(athlete_id));
create policy "athlete writes set logs" on set_logs for all
  using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());
create policy "coach reads set logs" on set_logs for select using (is_coach_of(athlete_id));

create policy "own events" on events for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Usage metrics, run weekly by the app owner with the service role.
-- security_invoker: a normal user querying it only ever sees their own events.
create view gate_metrics with (security_invoker = true) as
select
  date_trunc('week', ts) as week,
  count(*) filter (where name = 'set_confirmed') as sets_confirmed,
  avg(case when (payload->>'as_prescribed')::boolean then 1 else 0 end) filter (where name = 'set_confirmed') as pct_as_prescribed,
  percentile_cont(0.5) within group (order by (payload->>'ms_since_rest_end')::numeric)
    filter (where name = 'set_confirmed' and payload ? 'ms_since_rest_end' and payload->>'ms_since_rest_end' is not null) as median_ms_rest_to_confirm,
  count(distinct user_id) filter (where name = 'session_completed') as active_lifters
from events group by 1;
