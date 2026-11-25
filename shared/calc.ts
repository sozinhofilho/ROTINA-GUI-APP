// Regras de cálculo do dia e dos períodos. Usado no front e nas Functions.
import type {
  AppData,
  DayOverride,
  ExtraEntry,
  MealLog,
  PlanMeal,
  PlanWorkout,
  Settings,
  WorkoutLog,
} from './types.ts'
import { addDays, dateRange, weekdayOf } from './dates.ts'

export interface DayMeal {
  plan: PlanMeal | null
  log: MealLog | null
  name: string
  time: string | null
}

export interface DayWorkout {
  plan: PlanWorkout | null
  log: WorkoutLog | null
  name: string
  /** Se veio de outro dia via "Trocar de dia". */
  movedFrom: DayOverride | null
}

export interface DayStats {
  date: string
  kcalIn: number
  kcalPlanned: number
  kcalExtras: number
  goal: number
  tolerance: number
  min: number
  max: number
  status: 'vazio' | 'abaixo' | 'dentro' | 'acima'
  inGoal: boolean
  kcalWorkouts: number
  base: number | null
  spent: number
  balance: number | null
  mealsDone: number
  mealsTotal: number
  workoutsDone: number
  workoutsPlanned: number
  workoutsPlannedDone: number
  proteinDone: number
  proteinPlanned: number
  hasRecord: boolean
}

export interface DayView {
  date: string
  meals: DayMeal[]
  workouts: DayWorkout[]
  extras: ExtraEntry[]
  /** Treinos do plano base deste dia que foram movidos para outra data. */
  movedAway: { plan: PlanWorkout; override: DayOverride }[]
  stats: DayStats
}

const byTime = (a: string | null, b: string | null) => (a ?? '99:99').localeCompare(b ?? '99:99')

export function mealKcal(log: MealLog, plan: PlanMeal | null): number {
  return log.kcal_real ?? log.kcal_planned ?? plan?.kcal ?? 0
}

export function workoutKcal(log: WorkoutLog, plan: PlanWorkout | null): number {
  return log.kcal ?? plan?.kcal ?? 0
}

export function expandDay(date: string, data: AppData): DayView {
  const wd = weekdayOf(date)

  const planMeals = data.plan_meals
    .filter((m) => m.weekday === wd)
    .sort((a, b) => byTime(a.time, b.time) || a.sort - b.sort)
  const dayMealLogs = data.meal_logs.filter((l) => l.date === date)
  const planMealIds = new Set(planMeals.map((m) => m.id))
  const allPlanMeals = new Map(data.plan_meals.map((m) => [m.id, m]))

  const meals: DayMeal[] = planMeals.map((plan) => ({
    plan,
    log: dayMealLogs.find((l) => l.plan_meal_id === plan.id) ?? null,
    name: plan.name,
    time: plan.time,
  }))
  for (const log of dayMealLogs) {
    if (log.plan_meal_id && planMealIds.has(log.plan_meal_id)) continue
    const plan = log.plan_meal_id ? (allPlanMeals.get(log.plan_meal_id) ?? null) : null
    meals.push({ plan, log, name: log.meal_name || plan?.name || 'Refeição', time: plan?.time ?? null })
  }
  meals.sort((a, b) => byTime(a.time, b.time))

  const workoutById = new Map(data.plan_workouts.map((w) => [w.id, w]))
  const awayOverrides = data.overrides.filter((o) => o.from_date === date)
  const awayIds = new Set(awayOverrides.map((o) => o.plan_workout_id))
  const movedAway = awayOverrides
    .map((override) => ({ plan: workoutById.get(override.plan_workout_id)!, override }))
    .filter((x) => x.plan)

  const dayWorkoutLogs = data.workout_logs.filter((l) => l.date === date)
  const workouts: DayWorkout[] = data.plan_workouts
    .filter((w) => w.weekday === wd && !awayIds.has(w.id))
    .sort((a, b) => a.sort - b.sort)
    .map((plan) => ({ plan, log: null, name: plan.name, movedFrom: null }))
  for (const o of data.overrides.filter((o) => o.to_date === date)) {
    const plan = workoutById.get(o.plan_workout_id)
    if (plan && !workouts.some((w) => w.plan?.id === plan.id)) {
      workouts.push({ plan, log: null, name: plan.name, movedFrom: o })
    }
  }
  for (const w of workouts) {
    w.log = dayWorkoutLogs.find((l) => l.plan_workout_id === w.plan!.id) ?? null
  }
  const shownIds = new Set(workouts.map((w) => w.plan!.id))
  for (const log of dayWorkoutLogs) {
    if (log.plan_workout_id && shownIds.has(log.plan_workout_id)) continue
    const plan = log.plan_workout_id ? (workoutById.get(log.plan_workout_id) ?? null) : null
    workouts.push({ plan: null, log, name: log.name || plan?.name || 'Treino', movedFrom: null })
  }

  const extras = data.extras
    .filter((e) => e.date === date)
    .sort((a, b) => byTime(a.time, b.time))

  return { date, meals, workouts, extras, movedAway, stats: computeStats(date, meals, workouts, extras, data.settings) }
}

export function computeStats(
  date: string,
  meals: DayMeal[],
  workouts: DayWorkout[],
  extras: ExtraEntry[],
  settings: Settings,
): DayStats {
  const goal = settings.calorie_goal
  const tolerance = Math.round((goal * settings.tolerance_pct) / 100)
  const doneMeals = meals.filter((m) => m.log?.done)
  const kcalExtras = extras.reduce((s, e) => s + e.kcal, 0)
  const kcalIn = doneMeals.reduce((s, m) => s + mealKcal(m.log!, m.plan), 0) + kcalExtras
  const plannedMeals = meals.filter((m) => m.plan && m.plan.weekday === weekdayOf(date))
  const kcalPlanned = plannedMeals.reduce((s, m) => s + (m.plan?.kcal ?? 0), 0)
  const proteinPlanned = plannedMeals.reduce((s, m) => s + (m.plan?.protein ?? 0), 0)
  const proteinDone = doneMeals.reduce((s, m) => s + (m.plan?.protein ?? 0), 0)

  const doneWorkouts = workouts.filter((w) => w.log?.done)
  const kcalWorkouts = doneWorkouts.reduce((s, w) => s + workoutKcal(w.log!, w.plan), 0)
  const base = settings.base_expenditure
  const spent = kcalWorkouts + (base ?? 0)
  const planned = workouts.filter((w) => w.plan)

  const hasRecord = doneMeals.length > 0 || extras.length > 0
  const min = goal - tolerance
  const max = goal + tolerance
  const inGoal = hasRecord && kcalIn >= min && kcalIn <= max
  const status: DayStats['status'] = !hasRecord
    ? 'vazio'
    : kcalIn < min
      ? 'abaixo'
      : kcalIn > max
        ? 'acima'
        : 'dentro'

  return {
    date,
    kcalIn,
    kcalPlanned,
    kcalExtras,
    goal,
    tolerance,
    min,
    max,
    status,
    inGoal,
    kcalWorkouts,
    base,
    spent,
    balance: base != null ? kcalIn - spent : null,
    mealsDone: meals.filter((m) => m.plan && m.log?.done).length,
    mealsTotal: plannedMeals.length,
    workoutsDone: doneWorkouts.length,
    workoutsPlanned: planned.length,
    workoutsPlannedDone: planned.filter((w) => w.log?.done).length,
    proteinDone,
    proteinPlanned,
    hasRecord,
  }
}

export interface PeriodSummary {
  from: string
  to: string
  days: number
  daysWithRecord: number
  daysInGoal: number
  avgKcalIn: number
  avgSpent: number
  avgWorkoutKcal: number
  hasBase: boolean
  mealsDone: number
  mealsTotal: number
  pctMeals: number
  workoutsPlannedDone: number
  workoutsPlanned: number
  workoutsDone: number
  pctWorkouts: number
  bestStreak: number
  daily: DayStats[]
}

/** Resumo de um período. Só conta dias até `today` (dias futuros não entram). */
export function summarize(from: string, to: string, data: AppData, today: string): PeriodSummary {
  const end = to < today ? to : today
  const daily = from <= end ? dateRange(from, end).map((d) => expandDay(d, data).stats) : []
  const rec = daily.filter((d) => d.hasRecord)
  const sum = (arr: DayStats[], f: (d: DayStats) => number) => arr.reduce((s, d) => s + f(d), 0)
  const mealsDone = sum(daily, (d) => d.mealsDone)
  const mealsTotal = sum(daily, (d) => d.mealsTotal)
  const wPlanned = sum(daily, (d) => d.workoutsPlanned)
  const wPlannedDone = sum(daily, (d) => d.workoutsPlannedDone)
  const activeDays = daily.filter((d) => d.hasRecord || d.workoutsDone > 0)

  let best = 0
  let run = 0
  for (const d of daily) {
    run = d.inGoal ? run + 1 : 0
    best = Math.max(best, run)
  }

  return {
    from,
    to,
    days: daily.length,
    daysWithRecord: rec.length,
    daysInGoal: daily.filter((d) => d.inGoal).length,
    avgKcalIn: rec.length ? Math.round(sum(rec, (d) => d.kcalIn) / rec.length) : 0,
    avgSpent: activeDays.length ? Math.round(sum(activeDays, (d) => d.spent) / activeDays.length) : 0,
    avgWorkoutKcal: activeDays.length ? Math.round(sum(activeDays, (d) => d.kcalWorkouts) / activeDays.length) : 0,
    hasBase: data.settings.base_expenditure != null,
    mealsDone,
    mealsTotal,
    pctMeals: mealsTotal ? Math.round((mealsDone / mealsTotal) * 100) : 0,
    workoutsPlannedDone: wPlannedDone,
    workoutsPlanned: wPlanned,
    workoutsDone: sum(daily, (d) => d.workoutsDone),
    pctWorkouts: wPlanned ? Math.round((wPlannedDone / wPlanned) * 100) : 0,
    bestStreak: best,
    daily,
  }
}

/**
 * Sequência atual de dias seguidos dentro da meta, terminando hoje
 * (ou ontem, se hoje ainda não está dentro da meta).
 */
export function currentStreak(data: AppData, today: string, maxDays = 366): number {
  let d = today
  if (!expandDay(d, data).stats.inGoal) d = addDays(d, -1)
  let n = 0
  while (n < maxDays && expandDay(d, data).stats.inGoal) {
    n++
    d = addDays(d, -1)
  }
  return n
}

/** Sequência atual de dias seguidos com todos os treinos previstos feitos (dias sem treino previsto não quebram). */
export function workoutStreak(data: AppData, today: string, maxDays = 366): number {
  let d = today
  const s0 = expandDay(d, data).stats
  if (s0.workoutsPlanned > s0.workoutsPlannedDone) d = addDays(d, -1)
  let n = 0
  for (let i = 0; i < maxDays; i++) {
    const s = expandDay(d, data).stats
    if (s.workoutsPlanned === 0) {
      d = addDays(d, -1)
      continue
    }
    if (s.workoutsPlannedDone < s.workoutsPlanned) break
    n++
    d = addDays(d, -1)
  }
  return n
}
