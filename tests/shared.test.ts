import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { currentStreak, expandDay, summarize } from '../shared/calc.ts'
import { addDays, todayISO, weekStart, weekdayOf } from '../shared/dates.ts'
import { applyOp, importDayToOps, importPlanToRows, pickWorkoutForActivity } from '../shared/logic.ts'
import { ImportDaySchema, ImportPlanSchema, OpSchema } from '../shared/schemas.ts'
import type { AppData, MealLog } from '../shared/types.ts'
import { DEFAULT_SETTINGS } from '../shared/types.ts'

function seedData(): AppData {
  const plan = ImportPlanSchema.parse(JSON.parse(readFileSync('supabase/seed-plan.json', 'utf8')))
  const { meals, workouts } = importPlanToRows(plan)
  return { settings: { ...DEFAULT_SETTINGS }, plan_meals: meals, plan_workouts: workouts, overrides: [], meal_logs: [], workout_logs: [], extras: [], water: [], body: [] }
}

const WED = '2026-11-25' // quarta
const FRI = '2026-11-27'
const SAT = '2026-11-28'

function checkAllMeals(data: AppData, date: string, real?: number): AppData {
  for (const m of expandDay(date, data).meals) {
    const row: MealLog = { id: crypto.randomUUID(), date, plan_meal_id: m.plan!.id, meal_name: m.name, done: true, kcal_planned: m.plan!.kcal, kcal_real: real ?? null, note: '', photo_path: null, ai_estimate: null }
    data = applyOp(data, { t: 'meal_log.upsert', row })
  }
  return data
}

describe('datas', () => {
  it('fuso de São Paulo e semana começando na segunda', () => {
    expect(todayISO('America/Sao_Paulo', new Date('2026-11-26T02:30:00Z'))).toBe('2026-11-25')
    expect(weekdayOf(WED)).toBe(3)
    expect(weekStart(WED)).toBe('2026-11-23')
    expect(weekStart('2026-11-29')).toBe('2026-11-23')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('seed', () => {
  it('cobre a dieta e o treino dos PDFs', () => {
    const d = seedData()
    expect(d.plan_meals).toHaveLength(35)
    const wed = expandDay(WED, d)
    expect(wed.meals.map((m) => m.name)).toEqual(['Café da manhã', 'Almoço', 'Lanche da tarde', 'Jantar', 'Ceia'])
    expect(wed.stats.kcalPlanned).toBe(2501)
    expect(wed.stats.proteinPlanned).toBe(172)
    expect(wed.workouts.map((w) => w.name)).toEqual(['HYROX'])
    expect(expandDay('2026-11-24', d).workouts.map((w) => w.name)).toEqual(['Upper A', 'Corrida leve 6 km'])
    expect(expandDay('2026-11-29', d).workouts.map((w) => w.name)).toEqual(['Upper C', 'Corrida leve 6 km'])
  })
})

describe('regras de cálculo', () => {
  it('ingerido usa real quando preenchido, senão previsto, mais extras', () => {
    let d = seedData()
    d = checkAllMeals(d, WED)
    expect(expandDay(WED, d).stats).toMatchObject({ kcalIn: 2501, status: 'dentro', inGoal: true })
    d = applyOp(d, { t: 'extra.upsert', row: { id: crypto.randomUUID(), date: WED, time: '21:00', description: 'cerveja', kcal: 300, category: 'alcool' } })
    expect(expandDay(WED, d).stats).toMatchObject({ kcalIn: 2801, status: 'acima', inGoal: false })
    const lunch = expandDay(WED, d).meals[1].log!
    d = applyOp(d, { t: 'meal_log.upsert', row: { ...lunch, kcal_real: 100 } })
    expect(expandDay(WED, d).stats.kcalIn).toBe(2801 - 518 + 100)
  })

  it('tolerância configurável e gasto base opcional', () => {
    let d = seedData()
    d = checkAllMeals(d, WED, 400) // 2000
    expect(expandDay(WED, d).stats.status).toBe('abaixo')
    d = applyOp(d, { t: 'settings.update', row: { tolerance_pct: 25 } })
    expect(expandDay(WED, d).stats.status).toBe('dentro')
    const w = expandDay(WED, d).workouts[0]
    d = applyOp(d, { t: 'workout_log.upsert', row: { id: crypto.randomUUID(), date: WED, plan_workout_id: w.plan!.id, name: 'HYROX', done: true, duration_min: 60, kcal: 700, distance_m: null, avg_hr: null, avg_pace: null, note: '', source: 'manual', strava_activity_id: null } })
    expect(expandDay(WED, d).stats).toMatchObject({ spent: 700, balance: null })
    d = applyOp(d, { t: 'settings.update', row: { base_expenditure: 2000 } })
    expect(expandDay(WED, d).stats).toMatchObject({ spent: 2700, balance: -700 })
  })

  it('trocar de dia move o treino só naquela data', () => {
    let d = seedData()
    const hyrox = expandDay(FRI, d).workouts[0].plan!
    d = applyOp(d, { t: 'override.upsert', row: { id: crypto.randomUUID(), plan_workout_id: hyrox.id, from_date: FRI, to_date: SAT } })
    expect(expandDay(FRI, d).workouts).toHaveLength(0)
    expect(expandDay(FRI, d).movedAway).toHaveLength(1)
    expect(expandDay(SAT, d).workouts.map((w) => w.name)).toEqual(['Lower B', 'HYROX'])
    expect(expandDay(addDays(FRI, 7), d).workouts.map((w) => w.name)).toEqual(['HYROX'])
  })

  it('resumo e sequência', () => {
    let d = seedData()
    for (const day of ['2026-11-23', '2026-11-24', '2026-11-25']) d = checkAllMeals(d, day)
    const s = summarize('2026-11-23', '2026-11-29', d, WED)
    expect(s).toMatchObject({ days: 3, daysInGoal: 3, avgKcalIn: 2501, pctMeals: 100, bestStreak: 3 })
    expect(currentStreak(d, WED)).toBe(3)
    expect(currentStreak(d, '2026-11-26')).toBe(3)
  })
})

describe('importações e validação', () => {
  it('rejeita plano inválido com mensagem legível', () => {
    const r = ImportPlanSchema.safeParse({ meals: [{ weekdays: 'xyz', name: 'A', time: '25:00', kcal: -1 }] })
    expect(r.success).toBe(false)
  })

  it('importa lançamentos do dia casando nomes com o plano', () => {
    const d = seedData()
    const day = ImportDaySchema.parse({
      date: WED,
      meals: [{ name: 'almoco', kcal: 650 }],
      extras: [{ description: '2 cervejas', kcal: 300, category: 'alcool' }],
      workouts: [{ name: 'Hyrox', duration_min: 62, kcal: 740 }, { name: 'Caminhada', kcal: 100 }],
    })
    const ops = importDayToOps(day, d)
    ops.forEach((op) => expect(OpSchema.safeParse(op).success).toBe(true))
    const after = ops.reduce(applyOp, d)
    const v = expandDay(WED, after)
    expect(v.meals[1].log).toMatchObject({ done: true, kcal_real: 650 })
    expect(v.workouts[0].log).toMatchObject({ done: true, kcal: 740, source: 'import' })
    expect(v.workouts[1].plan).toBeNull()
    expect(v.stats.kcalIn).toBe(950)
  })

  it('atividade do Strava cumpre o treino do mesmo tipo', () => {
    const d = seedData()
    const tue = expandDay('2026-11-24', d).workouts
    expect(pickWorkoutForActivity(tue, 'Run')?.plan?.name).toBe('Corrida leve 6 km')
    expect(pickWorkoutForActivity(tue, 'WeightTraining')?.plan?.name).toBe('Upper A')
    expect(pickWorkoutForActivity(tue, 'Swim')?.plan?.name).toBe('Upper A')
    expect(pickWorkoutForActivity(expandDay(WED, d).workouts, 'Run')).toBeNull()
  })
})
