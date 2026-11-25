-- Arquivo único para colar no SQL Editor do Supabase (= todas as migrações + seed).

-- ===== 0001_init.sql =====
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

-- ===== 0003_mcp.sql =====
-- Conector MCP: pace médio nos treinos.
alter table public.workout_logs add column if not exists avg_pace text
  check (avg_pace is null or avg_pace ~ '^[0-9]{1,2}:[0-5][0-9]$');

-- Seed: plano inicial (dieta 2.500 kcal + treino híbrido HYROX).
-- Gerado por scripts/gen-seed.ts a partir de supabase/seed-plan.json. Pode rodar de novo: substitui o plano.

begin;
delete from public.day_overrides;
delete from public.plan_meals;
delete from public.plan_workouts;

update public.settings set calorie_goal = 2500, tolerance_pct = 10, base_expenditure = null, updated_at = now() where id = 1;

insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('a60e2911-6efd-42c4-a7d3-7c728498c3b1', 0, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('9da6f084-30c8-44b7-aa74-4269321f1d5d', 1, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('2974f888-273e-43ed-b9c9-879f2da08fe8', 2, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('897e812f-a674-4857-a5b7-89545d4cfa5c', 3, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('34b3f1dd-38c2-4810-b7c3-23317ab2fe02', 4, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('2ebcbb2a-dfc7-4f6f-8afd-69ad69f4e61d', 5, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('5e19f701-5a45-496f-aacf-f9416970f347', 6, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('c92cfcaf-c3a5-460d-bb96-6c5d8479ee37', 0, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('90af392f-2885-4c7b-ac2c-b174c2915191', 1, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('4e36302a-4300-4e7a-95e7-fd983bfa50f9', 2, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('e89d9467-03cf-44fa-9905-f17739744198', 3, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('ad4d144a-a97b-48a6-bf68-4459dc0f514f', 4, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('67a31fe4-0c94-4bc0-acba-05ee5c1f5f9b', 5, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('6e7f3696-3893-4eba-9c7e-99c65b8f6f2e', 6, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('1c18db58-d801-45ee-868c-1207e78b4544', 0, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('9f39395c-8d35-4b2c-8efa-ec1afe106c20', 1, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('81b3822e-c9ca-46a6-aa41-dee36d5f0f5c', 2, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('4fceefd4-96bf-4cae-9775-63083a93da11', 3, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('68c78961-68d6-4525-9995-ea7f20925f65', 4, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('c9a77ffc-1019-4e2b-91de-f47f7ad8fb77', 5, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('9673673b-e4fe-49a0-8e4e-b868a016c33c', 6, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('92c2db7c-4baf-4eed-8a73-1b3b8ff06529', 0, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('98d064fa-cc3e-401d-9e8b-16c072e6903c', 1, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('f6c1b3c6-379b-4669-bdc5-e78c814a09de', 2, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('750fa8cf-cce2-487c-aca6-72875030208f', 3, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('d5491585-486a-4b5d-acea-77b3dc634dcc', 4, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('651e0a48-60a7-47df-9049-bfd2afe43694', 5, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('edcc32c9-0929-4ee2-b76a-a0d7ea1db43d', 6, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('10172015-08a1-4de3-b4fe-8daaf1bcca04', 0, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('b94dfd19-0fce-442c-b2ed-a58ed5627e68', 1, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('6a204f0b-963f-4d4c-b624-bcc86ebe0e02', 2, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('e30bfd94-3d97-4bc7-ab24-34999fd93428', 3, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('15b1d8ae-25ae-4d20-b209-526dd5983f9b', 4, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('121f7bd8-3dd0-40f6-857b-2d7fb8f483c6', 5, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('7f7d04a4-60e2-4dc0-b72f-c5d3f72c47eb', 6, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);

insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('4699220f-2ca3-4980-83b6-d6ea6d458faa', 1, 'HYROX', 'hyrox', null, 'Treino HYROX.', '[]'::jsonb, 60, 700, 0);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('82bd90ef-4898-4b05-bb9a-345817b33140', 3, 'HYROX', 'hyrox', null, 'Treino HYROX.', '[]'::jsonb, 60, 700, 0);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('0a51c93d-b7c4-467a-944c-2802c4a7be61', 5, 'HYROX', 'hyrox', null, 'Treino HYROX.', '[]'::jsonb, 60, 700, 0);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('66893570-af54-4948-8dd8-9a3cd051cbd1', 2, 'Upper A', 'strength', null, 'Treino A — Upper Body.', '[{"name":"Supino inclinado com halteres","sets":"3","reps":"6–10"},{"name":"Voador","sets":"2","reps":"8–12"},{"name":"Remada alta máquina","sets":"3","reps":"6–10"},{"name":"Puxada neutra na polia","sets":"2","reps":"6–10"},{"name":"Desenvolvimento máquina","sets":"2","reps":"6–10"},{"name":"Elevação lateral com halteres","sets":"2","reps":"10–15"},{"name":"Tríceps francês na polia com corda","sets":"2","reps":"8–12"},{"name":"Rosca direta barra W","sets":"2","reps":"8–12"}]'::jsonb, 60, 300, 1);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('20346679-4416-4825-b707-6958b762f7e6', 0, 'Upper C', 'strength', null, 'Treino C — Upper Body.', '[{"name":"Puxada romana","sets":"3","reps":"6–10"},{"name":"Remada baixa pronada","sets":"3","reps":"6–10"},{"name":"Supino reto com halteres","sets":"3","reps":"6–10"},{"name":"Cross over polia alta","sets":"2","reps":"8–12"},{"name":"Elevação lateral máquina","sets":"2","reps":"10–15"},{"name":"Voador inverso","sets":"2","reps":"10–15"},{"name":"Rosca martelo com halteres","sets":"2","reps":"8–12"},{"name":"Tríceps na polia com barra","sets":"2","reps":"8–12"}]'::jsonb, 60, 300, 2);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('87bd0eeb-286b-4589-a135-298e622abe04', 0, 'Corrida leve 6 km', 'run', null, 'Corrida leve, ritmo confortável, 6 km.', '[]'::jsonb, 40, 450, 3);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('b6c7b82b-9b3f-4825-871c-dd6b8c8e3376', 2, 'Corrida leve 6 km', 'run', null, 'Corrida leve, ritmo confortável, 6 km.', '[]'::jsonb, 40, 450, 3);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('5c73b7f8-d40d-43f0-956d-8087100416de', 4, 'Corrida intervalada (tiros)', 'run', null, 'Corrida intervalada com tiros.', '[]'::jsonb, 50, 550, 4);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('dd38c8ba-c659-4d01-bd60-3841538906bb', 6, 'Lower B', 'strength', null, 'Treino B — Lower Body.', '[{"name":"RDL com barra","sets":"2","reps":"6–8"},{"name":"Agachamento búlgaro","sets":"2","reps":"6–10"},{"name":"Cadeira flexora","sets":"2","reps":"8–12"},{"name":"Agachamento Hack","sets":"2","reps":"6–10"},{"name":"Cadeira abdutora","sets":"2","reps":"12–15"},{"name":"Panturrilha em pé","sets":"2","reps":"8–12"},{"name":"Panturrilha sentada","sets":"2","reps":"10–15"}]'::jsonb, 55, 350, 5);

commit;
