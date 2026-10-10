-- FUEL check-in, Strong history import, readiness check.
-- Mirrors Dexie v3 (src/db/schema.ts) via src/sync/mapping.ts. Additive only.

-- ── Imported history + readiness on existing tables ────────────────────────────
alter table sessions
  add column source text check (source is null or source in ('app', 'import')),
  add column import_source text check (import_source is null or import_source in ('strong', 'tracker')),
  add column sleep text check (sleep is null or sleep in ('rough', 'ok', 'great')),
  add column energy text check (energy is null or energy in ('low', 'normal', 'high'));

alter table set_logs
  add column source_set_type text;

alter table athlete_programmes
  add column source text check (source is null or source = 'import');

-- Plate-loaded machines (leg press, hack squat…): loaded with plates, no bar.
alter table exercises drop constraint exercises_load_type_check;
alter table exercises add constraint exercises_load_type_check
  check (load_type in ('barbell', 'dumbbell', 'machine', 'plates', 'bodyweight'));

alter table programme_exercises
  add column target_rpe_min numeric check (target_rpe_min is null or target_rpe_min between 5 and 10);

-- ── FUEL: one row per athlete per date (the local id is the date) ─────────────
create table nutrition_days (
  athlete_id uuid not null references profiles on delete cascade,
  date date not null,
  protein numeric check (protein is null or protein between 0 and 1000),
  kcal numeric check (kcal is null or kcal between 0 and 20000),
  -- Protein target in grams at the time of saving (snapshotted, so changing the target
  -- later never rewrites history).
  target_g numeric check (target_g is null or target_g between 0 and 1000),
  -- Quick guesses (the usual entry): protein against the target, and the day's food overall.
  protein_level text check (protein_level is null or protein_level in ('under', 'hit', 'over')),
  food_level text check (food_level is null or food_level in ('light', 'normal', 'big')),
  updated_at timestamptz not null default now(),
  primary key (athlete_id, date)
);

create table bodyweight_logs (
  athlete_id uuid not null references profiles on delete cascade,
  date date not null,
  -- In the athlete's units (kg or lb), hence the wide range.
  kg numeric not null check (kg between 20 and 900),
  updated_at timestamptz not null default now(),
  primary key (athlete_id, date)
);

create trigger touch before insert or update on nutrition_days for each row execute function touch_updated_at();
create trigger touch before insert or update on bodyweight_logs for each row execute function touch_updated_at();

create index nutrition_days_pull on nutrition_days (athlete_id, updated_at, date);
create index bodyweight_logs_pull on bodyweight_logs (athlete_id, updated_at, date);

alter table nutrition_days enable row level security;
alter table bodyweight_logs enable row level security;

-- Health data: the athlete writes; a consented coach reads (same rule as workouts).
create policy "athlete writes nutrition" on nutrition_days for all
  using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());
create policy "coach reads nutrition" on nutrition_days for select using (is_coach_of(athlete_id));
create policy "athlete writes bodyweight" on bodyweight_logs for all
  using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());
create policy "coach reads bodyweight" on bodyweight_logs for select using (is_coach_of(athlete_id));
