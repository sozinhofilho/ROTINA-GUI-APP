// Gera supabase/migrations/0002_seed.sql e supabase/setup.sql a partir de supabase/seed-plan.json.
// Uso: node scripts/gen-seed.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { ImportPlanSchema } from '../shared/schemas.ts'
import { importPlanToRows } from '../shared/logic.ts'

const root = new URL('..', import.meta.url)
const raw = JSON.parse(readFileSync(new URL('supabase/seed-plan.json', root), 'utf8'))
const plan = ImportPlanSchema.parse(raw)
const { meals, workouts } = importPlanToRows(plan)

const q = (v: unknown): string => {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'object') return `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`
  return `'${String(v).replaceAll("'", "''")}'`
}

const lines: string[] = [
  '-- Seed: plano inicial (dieta 2.500 kcal + treino híbrido HYROX).',
  '-- Gerado por scripts/gen-seed.ts a partir de supabase/seed-plan.json. Pode rodar de novo: substitui o plano.',
  '',
  'begin;',
  'delete from public.day_overrides;',
  'delete from public.plan_meals;',
  'delete from public.plan_workouts;',
  '',
]
if (plan.settings) {
  const s = plan.settings
  lines.push(
    `update public.settings set calorie_goal = ${q(s.calorie_goal)}, tolerance_pct = ${q(s.tolerance_pct)}, base_expenditure = ${q(s.base_expenditure)}, updated_at = now() where id = 1;`,
    '',
  )
}
for (const m of meals) {
  lines.push(
    `insert into public.plan_meals (id, weekday, name, time, description, items, kcal, protein, carbs, fat, sort) values (${[
      m.id, m.weekday, m.name, m.time, m.description, m.items, m.kcal, m.protein, m.carbs, m.fat, m.sort,
    ].map(q).join(', ')});`,
  )
}
lines.push('')
for (const w of workouts) {
  lines.push(
    `insert into public.plan_workouts (id, weekday, name, kind, time, details, exercises, duration_min, kcal, sort) values (${[
      w.id, w.weekday, w.name, w.kind, w.time, w.details, w.exercises, w.duration_min, w.kcal, w.sort,
    ].map(q).join(', ')});`,
  )
}
lines.push('', 'commit;', '')

const seed = lines.join('\n')
writeFileSync(new URL('supabase/migrations/0002_seed.sql', root), seed)
const init = readFileSync(new URL('supabase/migrations/0001_init.sql', root), 'utf8')
writeFileSync(
  new URL('supabase/setup.sql', root),
  `-- Arquivo único para colar no SQL Editor do Supabase (= 0001_init.sql + 0002_seed.sql).\n\n${init}\n${seed}`,
)
console.log(`seed: ${meals.length} refeições, ${workouts.length} treinos`)
