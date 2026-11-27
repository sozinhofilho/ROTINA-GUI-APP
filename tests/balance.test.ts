// Saldo calórico (aba Evolução, tela Hoje, MCP e Excel usam shared/balance.ts).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { balanceDay, balanceText, energyBalance, KCAL_PER_KG_FAT } from '../shared/balance.ts'
import { expandDay } from '../shared/calc.ts'
import { applyOp, importPlanToRows } from '../shared/logic.ts'
import { ImportPlanSchema, type Op } from '../shared/schemas.ts'
import type { AppData, MealLog, WorkoutLog } from '../shared/types.ts'
import { DEFAULT_SETTINGS } from '../shared/types.ts'

function seed(base: number | null = 2300): AppData {
  const plan = ImportPlanSchema.parse(JSON.parse(readFileSync('supabase/seed-plan.json', 'utf8')))
  const { meals, workouts } = importPlanToRows(plan)
  return { settings: { ...DEFAULT_SETTINGS, base_expenditure: base }, plan_meals: meals, plan_workouts: workouts, overrides: [], meal_logs: [], workout_logs: [], extras: [], water: [], body: [] }
}

const MON = '2026-11-23'
const WED = '2026-11-25'
const THU = '2026-11-26' // "hoje" nos testes

function meal(d: AppData, date: string, name: string, real: number | null = null): AppData {
  const m = expandDay(date, d).meals.find((x) => x.name === name)!
  const row: MealLog = { id: crypto.randomUUID(), date, plan_meal_id: m.plan!.id, meal_name: name, done: true, kcal_planned: m.plan!.kcal, kcal_real: real, note: '', photo_path: null, ai_estimate: null }
  return applyOp(d, { t: 'meal_log.upsert', row })
}

function workout(d: AppData, date: string, name: string, kcal: number | null): AppData {
  const w = expandDay(date, d).workouts.find((x) => x.name === name)!
  const row: WorkoutLog = { id: crypto.randomUUID(), date, plan_workout_id: w.plan!.id, name, done: true, duration_min: 60, kcal, distance_m: null, avg_hr: null, avg_pace: null, note: '', source: 'manual', strava_activity_id: null }
  return applyOp(d, { t: 'workout_log.upsert', row })
}

const ALL = ['Café da manhã', 'Almoço', 'Lanche da tarde', 'Jantar', 'Ceia']

describe('saldo do dia', () => {
  it('gasto total = basal + kcal real do treino; saldo = consumido − gasto total', () => {
    let d = seed()
    for (const m of ALL) d = meal(d, MON, m) // 2.501
    d = workout(d, MON, 'HYROX', 812) // real
    const b = balanceDay(expandDay(MON, d), THU)
    expect(b).toMatchObject({ kcalIn: 2501, kcalWorkouts: 812, kcalWorkoutsEstimated: 0, spent: 3112, balance: -611, hasFood: true })
  })

  it('treino sem kcal real usa a estimativa do plano e é marcado como estimado', () => {
    let d = seed()
    d = meal(d, MON, 'Almoço')
    d = workout(d, MON, 'HYROX', null) // plano: 700
    const b = balanceDay(expandDay(MON, d), THU)
    expect(b).toMatchObject({ kcalWorkouts: 700, kcalWorkoutsEstimated: 700, spent: 3000, balance: 518 - 3000 })
  })

  it('dia sem registro de comida não tem saldo (não é déficit)', () => {
    let d = seed()
    d = workout(d, MON, 'HYROX', 700)
    const b = balanceDay(expandDay(MON, d), THU)
    expect(b).toMatchObject({ hasFood: false, spent: 3000, balance: null })
  })
})

describe('saldo do período', () => {
  it('dias sem registro e o dia em andamento ficam fora das médias', () => {
    let d = seed()
    for (const m of ALL) d = meal(d, MON, m) // seg 2.501 − 2.300 (sem treino) = +201
    d = meal(d, WED, 'Almoço', 3000) // qua 3.000, treino HYROX real 700 → 3.000 − 3.000 = 0
    d = workout(d, WED, 'HYROX', 700)
    d = meal(d, THU, 'Café da manhã') // hoje: em andamento
    const b = energyBalance(MON, '2026-11-29', d, THU)
    expect(b).toMatchObject({ closedDays: 3, daysWithFood: 2, daysWithoutFood: 1, totalBalance: 201, avgBalance: 101, deficitDays: 0, surplusDays: 1 })
    expect(b.avgKcalIn).toBe(Math.round((2501 + 3000) / 2))
    expect(b.avgSpent).toBe(Math.round((2300 + 3000) / 2))
    expect(b.fatKg).toBe(Math.round((201 / KCAL_PER_KG_FAT) * 100) / 100)
    // terça: Upper A e corrida não feitos
    expect(b.missedWorkouts.map((m) => m.name)).toEqual(['HYROX', 'Upper A', 'Corrida leve 6 km'])
    expect(b.workoutsDone).toBe(1)
    expect(b.workoutsPlanned).toBe(4)
  })

  it('dia em andamento: projeção fazendo as refeições restantes como no plano', () => {
    let d = seed()
    d = meal(d, THU, 'Café da manhã') // 682
    d = workout(d, THU, 'Corrida intervalada (tiros)', 482)
    const b = energyBalance(MON, '2026-11-29', d, THU)
    expect(b.today).toMatchObject({ inProgress: true, kcalIn: 682, spent: 2782, balance: 682 - 2782 })
    expect(b.today!.projection).toEqual({ kcalIn: 2501, balance: 2501 - 2782, remainingMeals: ['Almoço', 'Lanche da tarde', 'Jantar', 'Ceia'] })
    expect(b.daysWithFood).toBe(0) // hoje não entra nas médias
  })

  it('sem gasto basal: não calcula saldo e pede para definir em Ajustes', () => {
    let d = seed(null)
    d = meal(d, MON, 'Almoço')
    const b = energyBalance(MON, '2026-11-29', d, THU)
    expect(b).toMatchObject({ base: null, totalBalance: null, avgBalance: null })
    expect(balanceText(b, null)).toMatch(/defina o gasto basal em Ajustes/)
  })
})

describe('check não sobrescreve registro real', () => {
  it('marcar/desmarcar mantém duração, kcal e observação (inclusive com cache antigo no celular)', () => {
    let server = seed()
    // Registro real feito pelo Claude
    server = workout(server, THU, 'Corrida intervalada (tiros)', 482)
    const real = server.workout_logs[0]
    server = applyOp(server, { t: 'workout_log.patch', id: real.id, date: THU, plan_workout_id: real.plan_workout_id, name: real.name, set: { note: 'Calorias do relógio' } })
    // Celular com cache antigo (não conhece o registro): toca no check e gera um id próprio
    const fromStalePhone: Op = { t: 'workout_log.patch', id: crypto.randomUUID(), date: THU, plan_workout_id: real.plan_workout_id, name: real.name, set: { done: false } }
    server = applyOp(server, fromStalePhone)
    server = applyOp(server, { ...fromStalePhone, set: { done: true } } as Op)
    expect(server.workout_logs).toHaveLength(1)
    expect(server.workout_logs[0]).toMatchObject({ id: real.id, done: true, kcal: 482, duration_min: 60, note: 'Calorias do relógio' })
  })

  it('check de treino sem registro cria só o "feito", sem copiar valores do plano', () => {
    let d = seed()
    const w = expandDay(THU, d).workouts[0]
    d = applyOp(d, { t: 'workout_log.patch', id: crypto.randomUUID(), date: THU, plan_workout_id: w.plan!.id, name: w.plan!.name, set: { done: true } })
    expect(d.workout_logs[0]).toMatchObject({ done: true, kcal: null, duration_min: null })
    expect(expandDay(THU, d).stats).toMatchObject({ kcalWorkouts: w.plan!.kcal, kcalWorkoutsEstimated: w.plan!.kcal })
  })

  it('check de refeição mantém kcal real e observação', () => {
    let d = seed()
    d = meal(d, THU, 'Lanche da tarde', 735)
    const log = d.meal_logs[0]
    d = applyOp(d, { t: 'meal_log.patch', id: log.id, date: THU, plan_meal_id: log.plan_meal_id, meal_name: log.meal_name, kcal_planned: 309, set: { note: '2 pães franceses' } })
    d = applyOp(d, { t: 'meal_log.patch', id: crypto.randomUUID(), date: THU, plan_meal_id: log.plan_meal_id, meal_name: log.meal_name, kcal_planned: 309, set: { done: false } })
    d = applyOp(d, { t: 'meal_log.patch', id: crypto.randomUUID(), date: THU, plan_meal_id: log.plan_meal_id, meal_name: log.meal_name, kcal_planned: 309, set: { done: true } })
    expect(d.meal_logs).toHaveLength(1)
    expect(d.meal_logs[0]).toMatchObject({ done: true, kcal_real: 735, note: '2 pães franceses' })
  })
})
