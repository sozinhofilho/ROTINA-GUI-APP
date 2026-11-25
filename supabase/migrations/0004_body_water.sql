-- Peso e fotos de evolução (segunda e sexta) e água do dia.

alter table public.settings add column if not exists water_goal_ml integer not null default 5000
  check (water_goal_ml between 0 and 15000);

create table if not exists public.water_logs (
  date date primary key,
  ml integer not null default 0 check (ml between 0 and 20000),
  updated_at timestamptz not null default now()
);

create table if not exists public.body_checkins (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  weight_kg numeric(5,1) check (weight_kg between 20 and 400),
  photo_front text,
  photo_side text,
  note text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.water_logs enable row level security;
alter table public.body_checkins enable row level security;
