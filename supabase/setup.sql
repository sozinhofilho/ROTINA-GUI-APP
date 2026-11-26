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

-- ===== 0004_body_water.sql =====
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

-- ===== 0005_grants.sql =====
-- Projetos novos do Supabase não liberam as tabelas criadas por SQL para a API.
-- O servidor do app (Netlify Functions) usa a chave secreta = papel service_role.
-- anon e authenticated continuam sem acesso (RLS ligado e sem grants).
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;

-- Seed: plano inicial (dieta 2.500 kcal + treino híbrido HYROX).
-- Gerado por scripts/gen-seed.ts a partir de supabase/seed-plan.json. Pode rodar de novo: substitui o plano.

begin;
delete from public.day_overrides;
delete from public.plan_meals;
delete from public.plan_workouts;

update public.settings set calorie_goal = 2500, tolerance_pct = 10, base_expenditure = null, updated_at = now() where id = 1;

insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('c6fab643-1c07-4286-9cea-172b8c1c2376', 0, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('a22d79f1-72da-41ce-bc63-8888411409eb', 1, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('0517a87c-a3b9-421f-8717-0b28c931c857', 2, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('548d29d7-2e23-4aeb-8223-038935f18d23', 3, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('7cf2e7b5-714e-487e-a12f-46292e4bbcd4', 4, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('01876c0d-0cff-419f-a12b-9f5f040d6cad', 5, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('44f4e50b-aba3-46d2-b1fa-905c920cd1dc', 6, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('f45bd696-389c-40a1-a581-a27934e0a192', 0, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('2f0a485f-93e2-4ca7-8650-794362815627', 1, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('21750c39-a9f2-40a2-aac6-20b0eb9f8a7a', 2, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('66eb800d-13cb-4f34-acc3-dcb8e69e26e8', 3, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('f1a1038d-296b-4fcc-a449-ef8737183666', 4, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('b59bcb39-780a-438f-9c63-e28270763dab', 5, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('b3b11423-b328-4bb0-b1e2-2c7328f387aa', 6, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('1353c1ac-30c3-4421-8266-36e1bc02eed3', 0, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('cda3094b-2b4a-48ca-9859-bbed39463fad', 1, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('b19916d6-2523-4ece-a6b8-88e03ca8d428', 2, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('54d7229d-253b-443e-8a12-a2cacf3f9e93', 3, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('85a66e92-2a12-4aa8-b79f-4e824dd58ebe', 4, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('0e9bd87d-2e8b-427c-a591-26e07b5106fd', 5, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('cc457e79-0d1f-495d-93ac-f4bd1b008b53', 6, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('da5998ce-d6cf-4152-8d5d-854f7fb128cd', 0, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('88116ab5-a155-4a47-8f0b-54d2f3013f6f', 1, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('e78244f0-b38c-4190-bdb6-eccb5e360f1f', 2, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('3c54682b-8ff6-4114-976e-45d808cdee87', 3, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('5000d0a9-f6b0-4831-9308-814a096a3744', 4, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('aa8ed530-c5cf-4577-a755-4ddeb0e3f3ac', 5, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('bec54a6f-bb53-43e4-a045-a981d7d258a3', 6, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('6d707468-17c9-4dc5-92d6-93d975115ee3', 0, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('efca1d9e-3c66-45c5-a1b0-6074da896595', 1, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('2b7c2cb8-f073-4448-83ac-b504f524e74d', 2, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('8a5f7ce2-0fac-441a-9c11-33fdf30e0ead', 3, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('90c92ae0-5830-4bdb-a308-923b5e61500a', 4, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('c69c7a96-e02d-446a-9ad7-2f112e7a1263', 5, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('fc3f9e51-32e0-4efc-82c1-6af7e652b030', 6, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);

insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('9f31d646-a06b-4934-bf60-fa2b66d2ef94', 1, 'HYROX', 'hyrox', null, 'Treino HYROX.', '[]'::jsonb, 60, 700, 0);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('0e57744f-f785-4bd4-a136-b89203ddb315', 3, 'HYROX', 'hyrox', null, 'Treino HYROX.', '[]'::jsonb, 60, 700, 0);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('6ce19a9a-9cb4-4218-878e-cb3e73db378a', 5, 'HYROX', 'hyrox', null, 'Treino HYROX.', '[]'::jsonb, 60, 700, 0);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('9e863918-d222-4b5d-bd5f-4c5546ec11f3', 2, 'Upper A', 'strength', null, 'Treino A — Upper Body.', '[{"name":"Supino inclinado com halteres","sets":"3","reps":"6–10"},{"name":"Voador","sets":"2","reps":"8–12"},{"name":"Remada alta máquina","sets":"3","reps":"6–10"},{"name":"Puxada neutra na polia","sets":"2","reps":"6–10"},{"name":"Desenvolvimento máquina","sets":"2","reps":"6–10"},{"name":"Elevação lateral com halteres","sets":"2","reps":"10–15"},{"name":"Tríceps francês na polia com corda","sets":"2","reps":"8–12"},{"name":"Rosca direta barra W","sets":"2","reps":"8–12"}]'::jsonb, 60, 300, 1);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('6bbaa25e-8280-4dc2-b930-d2851c41be20', 0, 'Upper C', 'strength', null, 'Treino C — Upper Body.', '[{"name":"Puxada romana","sets":"3","reps":"6–10"},{"name":"Remada baixa pronada","sets":"3","reps":"6–10"},{"name":"Supino reto com halteres","sets":"3","reps":"6–10"},{"name":"Cross over polia alta","sets":"2","reps":"8–12"},{"name":"Elevação lateral máquina","sets":"2","reps":"10–15"},{"name":"Voador inverso","sets":"2","reps":"10–15"},{"name":"Rosca martelo com halteres","sets":"2","reps":"8–12"},{"name":"Tríceps na polia com barra","sets":"2","reps":"8–12"}]'::jsonb, 60, 300, 2);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('3744e871-6b7f-4843-93ce-05ff6d48d7f8', 0, 'Corrida leve 6 km', 'run', null, 'Corrida leve, ritmo confortável, 6 km.', '[]'::jsonb, 40, 450, 3);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('02d82563-7544-4dd3-9d4d-b2883a4c383c', 2, 'Corrida leve 6 km', 'run', null, 'Corrida leve, ritmo confortável, 6 km.', '[]'::jsonb, 40, 450, 3);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('7783dfda-9710-4678-98b5-be465e484211', 4, 'Corrida intervalada (tiros)', 'run', null, 'Corrida intervalada com tiros.', '[]'::jsonb, 50, 550, 4);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('c8e509e7-6767-41e6-a3e5-ab5bdcfb2986', 6, 'Lower B', 'strength', null, 'Treino B — Lower Body.', '[{"name":"RDL com barra","sets":"2","reps":"6–8"},{"name":"Agachamento búlgaro","sets":"2","reps":"6–10"},{"name":"Cadeira flexora","sets":"2","reps":"8–12"},{"name":"Agachamento Hack","sets":"2","reps":"6–10"},{"name":"Cadeira abdutora","sets":"2","reps":"12–15"},{"name":"Panturrilha em pé","sets":"2","reps":"8–12"},{"name":"Panturrilha sentada","sets":"2","reps":"10–15"}]'::jsonb, 55, 350, 5);

commit;
