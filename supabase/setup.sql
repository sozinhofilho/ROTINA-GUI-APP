-- Arquivo único para colar no SQL Editor do Supabase (= 0001_init.sql + 0002_seed.sql).

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

-- Seed: plano inicial (dieta 2.500 kcal + treino híbrido HYROX).
-- Gerado por scripts/gen-seed.ts a partir de supabase/seed-plan.json. Pode rodar de novo: substitui o plano.

begin;
delete from public.day_overrides;
delete from public.plan_meals;
delete from public.plan_workouts;

update public.settings set calorie_goal = 2500, tolerance_pct = 10, base_expenditure = null, updated_at = now() where id = 1;

insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('00e33e8c-e314-4ea8-bb10-68d4bad8e45d', 0, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('37455552-47fe-4dc0-b856-eeb331445a29', 1, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('167bd893-b67b-443e-ba1c-31d0aacda439', 2, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('d1d50f61-9170-4be6-b66d-234439f4e9a4', 3, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('be2ddbc8-2bbe-4847-940a-45820dec3d2c', 4, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('63de0f39-818f-4214-b8ca-114dfc5e4942', 5, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('f060d819-87d5-4319-9022-87174da353ba', 6, 'Café da manhã', '08:30', 'Cuscuz com ovos e ricota + mamão com abacate e leite em pó. (08h30–09h00)', '[{"food":"Cuscuz","qty":"120 g","kcal":136},{"food":"Ovos inteiros","qty":"3 un. (150 g)","kcal":219},{"food":"Creme de ricota","qty":"30 g","kcal":64},{"food":"Mamão","qty":"150 g","kcal":68},{"food":"Abacate","qty":"100 g","kcal":96},{"food":"Leite em pó integral","qty":"20 g","kcal":99}]'::jsonb, 682, 33, 63, 35, 0);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('2f9fb925-4cf6-4c65-8370-8c977a5d9ff5', 0, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('b51ad806-14c0-4b9f-a373-8b192af5e200', 1, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('143d7eea-0bc4-4723-8165-8b9add921d1f', 2, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('0219fde4-faf6-4e25-a0ad-c70151148270', 3, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('ed825951-b76f-454b-83d5-f5b7f3e7162e', 4, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('a49c9cfd-99f5-4c70-b2e2-c9f741768d26', 5, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('bd6cf177-5f0b-4cd3-9502-b0896493c06d', 6, 'Almoço', '12:00', 'Frango, arroz e legumes com azeite. (12h00–13h00)', '[{"food":"Peito de frango","qty":"110 g","kcal":175},{"food":"Arroz branco","qty":"200 g","kcal":256},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"5 g","kcal":45}]'::jsonb, 518, 43, 64, 9, 1);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('2157f79c-149b-460d-ba21-9438dc753769', 0, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('a30369a1-a7b1-41f9-b3e6-3119349804fe', 1, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('649efd76-7743-47a6-9d5a-5010541d1ead', 2, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('65bf28b1-f84b-48b5-8a6d-af7d6a0eccaf', 3, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('c38ee4f8-f948-4bbf-97ea-5f862460b445', 4, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('33717174-8a93-4c18-bb00-00ea4c25576d', 5, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('0ed0a00f-e247-4a07-b55a-b5f32a3101cb', 6, 'Lanche da tarde', '16:00', 'Biscoito de arroz com patê de frango e creme de ricota. (16h00–17h00)', '[{"food":"Frango desfiado","qty":"70 g","kcal":111},{"food":"Creme de ricota","qty":"40 g","kcal":85},{"food":"Biscoito de arroz","qty":"30 g","kcal":113}]'::jsonb, 309, 28, 26, 9, 2);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('663c0f63-bba6-4c37-88d0-40bb828506a0', 0, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('b8f7629b-1c09-4ac7-98dd-c4615a487b0e', 1, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('2e3c2ea7-ab58-4bcc-bf39-c4a32e1159d1', 2, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('a9463cb7-cfaa-4e8b-ab68-da8422bb059d', 3, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('818dc5ed-19a9-4bf2-833a-385956569f9e', 4, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('ce213820-1079-4172-be04-7828ee264295', 5, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('f98d1a8d-449c-413b-a35d-40c1e841c895', 6, 'Jantar', '19:00', 'Frango, batata, arroz e legumes com azeite. (19h00–20h00)', '[{"food":"Peito de frango","qty":"90 g","kcal":143},{"food":"Batata inglesa","qty":"300 g","kcal":156},{"food":"Arroz branco","qty":"135 g","kcal":173},{"food":"Mix de legumes","qty":"120 g","kcal":42},{"food":"Azeite","qty":"10 g","kcal":90}]'::jsonb, 604, 38, 82, 14, 3);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('91f56e7c-f125-48f6-bead-1a5b2753469c', 0, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('856c38a5-c172-4103-8d0d-c7eb6c43051a', 1, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('0e0213f3-14c2-4b43-9dc0-57e1b4a0c8e2', 2, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('98ad06cf-d57b-4cdd-890e-20709360e5f6', 3, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('00159f96-0845-42ab-8334-fdbd15259072', 4, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('4a1c0c95-5b9d-43c3-ba8a-94c4f8209ef0', 5, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);
insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values ('8a209b68-bd82-4a6e-9cc4-507a8b778ce3', 6, 'Ceia', '21:30', 'Banana quente com leite em pó e mel + proteína de arroz com água. Canela opcional. (21h30–22h00)', '[{"food":"Banana","qty":"120 g","kcal":118},{"food":"Leite em pó integral","qty":"25 g","kcal":124},{"food":"Mel","qty":"10 g","kcal":31},{"food":"Rice Protein Growth","qty":"30 g","kcal":115}]'::jsonb, 388, 30, 48, 8, 4);

insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('0db6b97c-7d9b-44ed-a06b-37c02121a894', 1, 'HYROX', 'hyrox', null, 'Treino HYROX.', '[]'::jsonb, 60, 700, 0);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('48b783c7-6a58-4151-95e8-831a3f29feab', 3, 'HYROX', 'hyrox', null, 'Treino HYROX.', '[]'::jsonb, 60, 700, 0);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('bb3d2b15-c4b2-4f15-8fe8-232fc747e928', 5, 'HYROX', 'hyrox', null, 'Treino HYROX.', '[]'::jsonb, 60, 700, 0);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('1f710065-6ed8-4d1e-8c3b-89041d37f236', 2, 'Upper A', 'strength', null, 'Treino A — Upper Body.', '[{"name":"Supino inclinado com halteres","sets":"3","reps":"6–10"},{"name":"Voador","sets":"2","reps":"8–12"},{"name":"Remada alta máquina","sets":"3","reps":"6–10"},{"name":"Puxada neutra na polia","sets":"2","reps":"6–10"},{"name":"Desenvolvimento máquina","sets":"2","reps":"6–10"},{"name":"Elevação lateral com halteres","sets":"2","reps":"10–15"},{"name":"Tríceps francês na polia com corda","sets":"2","reps":"8–12"},{"name":"Rosca direta barra W","sets":"2","reps":"8–12"}]'::jsonb, 60, 300, 1);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('ba8ac318-d955-4e7f-99cd-f78eaa1f24b8', 0, 'Upper C', 'strength', null, 'Treino C — Upper Body.', '[{"name":"Puxada romana","sets":"3","reps":"6–10"},{"name":"Remada baixa pronada","sets":"3","reps":"6–10"},{"name":"Supino reto com halteres","sets":"3","reps":"6–10"},{"name":"Cross over polia alta","sets":"2","reps":"8–12"},{"name":"Elevação lateral máquina","sets":"2","reps":"10–15"},{"name":"Voador inverso","sets":"2","reps":"10–15"},{"name":"Rosca martelo com halteres","sets":"2","reps":"8–12"},{"name":"Tríceps na polia com barra","sets":"2","reps":"8–12"}]'::jsonb, 60, 300, 2);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('fa00e862-ed54-4b27-ad4e-3566816d1a87', 0, 'Corrida leve 6 km', 'run', null, 'Corrida leve, ritmo confortável, 6 km.', '[]'::jsonb, 40, 450, 3);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('9872176f-051e-41c1-bf75-245dfb86b111', 2, 'Corrida leve 6 km', 'run', null, 'Corrida leve, ritmo confortável, 6 km.', '[]'::jsonb, 40, 450, 3);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('f9b289eb-05a7-4ba2-826b-f2840584a6a3', 4, 'Corrida intervalada (tiros)', 'run', null, 'Corrida intervalada com tiros.', '[]'::jsonb, 50, 550, 4);
insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values ('62d0bf51-414b-4f9c-a272-7a4fc2da6c3f', 6, 'Lower B', 'strength', null, 'Treino B — Lower Body.', '[{"name":"RDL com barra","sets":"2","reps":"6–8"},{"name":"Agachamento búlgaro","sets":"2","reps":"6–10"},{"name":"Cadeira flexora","sets":"2","reps":"8–12"},{"name":"Agachamento Hack","sets":"2","reps":"6–10"},{"name":"Cadeira abdutora","sets":"2","reps":"12–15"},{"name":"Panturrilha em pé","sets":"2","reps":"8–12"},{"name":"Panturrilha sentada","sets":"2","reps":"10–15"}]'::jsonb, 55, 350, 5);

commit;
