-- Rotina: dieta e treino. Schema inicial.
-- Todas as tabelas têm RLS ligado e nenhuma policy: só a service role
-- (usada pelas Netlify Functions) consegue ler e escrever.

create extension if not exists pgcrypto;

-- Configurações (linha única, id = 1)
create table if not exists public.settings (
  id smallint primary key default 1 check (id = 1),
  calorie_goal integer not null default 2500 check (calorie_goal between 500 and 10000),
  tolerance_pct numeric(5,2) not null default 10 check (tolerance_pct between 0 and 100),
  base_expenditure integer check (base_expenditure between 0 and 10000),
  timezone text not null default 'America/Sao_Paulo',
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- Plano base de refeições por dia da semana (0 = domingo ... 6 = sábado)
create table if not exists public.plan_meals (
  id uuid primary key default gen_random_uuid(),
  weekday smallint not null check (weekday between 0 and 6),
  name text not null,
  time text not null check (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  description text not null default '',
  items jsonb not null default '[]'::jsonb,
  kcal integer not null default 0,
  protein numeric(6,1),
  carbs numeric(6,1),
  fat numeric(6,1),
  sort integer not null default 0,
  updated_at timestamptz not null default now()
);
create index if not exists plan_meals_weekday_idx on public.plan_meals (weekday);

-- Plano base de treinos por dia da semana
create table if not exists public.plan_workouts (
  id uuid primary key default gen_random_uuid(),
  weekday smallint not null check (weekday between 0 and 6),
  name text not null,
  kind text not null default 'other' check (kind in ('hyrox','run','strength','other')),
  time text check (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  details text not null default '',
  exercises jsonb not null default '[]'::jsonb,
  duration_min integer,
  kcal integer,
  sort integer not null default 0,
  updated_at timestamptz not null default now()
);
create index if not exists plan_workouts_weekday_idx on public.plan_workouts (weekday);

-- "Trocar de dia": move um treino do plano de uma data para outra (só naquela semana)
create table if not exists public.day_overrides (
  id uuid primary key default gen_random_uuid(),
  plan_workout_id uuid not null references public.plan_workouts(id) on delete cascade,
  from_date date not null,
  to_date date not null,
  created_at timestamptz not null default now(),
  unique (plan_workout_id, from_date)
);
create index if not exists day_overrides_to_idx on public.day_overrides (to_date);

-- Registro das refeições
create table if not exists public.meal_logs (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  plan_meal_id uuid references public.plan_meals(id) on delete set null,
  meal_name text not null default '',
  done boolean not null default false,
  kcal_planned integer,
  kcal_real integer,
  note text not null default '',
  photo_path text,
  ai_estimate jsonb,
  updated_at timestamptz not null default now(),
  unique (date, plan_meal_id)
);
create index if not exists meal_logs_date_idx on public.meal_logs (date);

-- Registro dos treinos (manual, importado ou Strava)
create table if not exists public.workout_logs (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  plan_workout_id uuid references public.plan_workouts(id) on delete set null,
  name text not null default '',
  done boolean not null default false,
  duration_min integer,
  kcal integer,
  distance_m numeric(10,1),
  avg_hr numeric(5,1),
  note text not null default '',
  source text not null default 'manual' check (source in ('manual','strava','import')),
  strava_activity_id bigint unique,
  updated_at timestamptz not null default now(),
  unique (date, plan_workout_id)
);
create index if not exists workout_logs_date_idx on public.workout_logs (date);

-- Extras fora do plano (álcool, lanche, refeição fora)
create table if not exists public.extra_entries (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  time text check (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  description text not null,
  kcal integer not null default 0,
  category text not null default 'outro' check (category in ('alcool','lanche','refeicao','outro')),
  created_at timestamptz not null default now()
);
create index if not exists extra_entries_date_idx on public.extra_entries (date);

-- Tokens do Strava (fase 2). Linha única.
create table if not exists public.strava_tokens (
  id smallint primary key default 1 check (id = 1),
  athlete_id bigint not null,
  access_token text not null,
  refresh_token text not null,
  expires_at bigint not null,
  updated_at timestamptz not null default now()
);

-- RLS ligado em tudo, sem policies (acesso só pela service role)
alter table public.settings enable row level security;
alter table public.plan_meals enable row level security;
alter table public.plan_workouts enable row level security;
alter table public.day_overrides enable row level security;
alter table public.meal_logs enable row level security;
alter table public.workout_logs enable row level security;
alter table public.extra_entries enable row level security;
alter table public.strava_tokens enable row level security;

-- Resumo diário (dias com algum registro)
create or replace view public.daily_summary
with (security_invoker = true) as
with days as (
  select date from public.meal_logs
  union select date from public.workout_logs
  union select date from public.extra_entries
),
agg as (
  select
    d.date,
    coalesce((select sum(coalesce(m.kcal_real, m.kcal_planned, 0)) from public.meal_logs m
              where m.date = d.date and m.done), 0)
      + coalesce((select sum(e.kcal) from public.extra_entries e where e.date = d.date), 0) as kcal_in,
    coalesce((select sum(e.kcal) from public.extra_entries e where e.date = d.date), 0) as kcal_extras,
    (select count(*) from public.meal_logs m where m.date = d.date and m.done) as meals_done,
    coalesce((select sum(w.kcal) from public.workout_logs w where w.date = d.date and w.done), 0) as kcal_workouts,
    (select count(*) from public.workout_logs w where w.date = d.date and w.done) as workouts_done
  from days d
)
select
  a.date,
  a.kcal_in,
  a.kcal_extras,
  a.meals_done,
  a.kcal_workouts,
  a.workouts_done,
  s.calorie_goal,
  s.tolerance_pct,
  s.base_expenditure,
  a.kcal_workouts + coalesce(s.base_expenditure, 0) as kcal_spent,
  case when s.base_expenditure is null then null
       else a.kcal_in - a.kcal_workouts - s.base_expenditure end as balance,
  (a.meals_done > 0 or a.kcal_extras > 0)
    and abs(a.kcal_in - s.calorie_goal) <= s.calorie_goal * s.tolerance_pct / 100 as in_goal
from agg a
cross join public.settings s
where s.id = 1
order by a.date;

-- Bucket privado para as fotos dos pratos
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;
