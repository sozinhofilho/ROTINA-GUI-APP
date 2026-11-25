// Lógica pura compartilhada: aplicar operações localmente (otimista/offline),
// converter importações em operações e escolher qual treino uma atividade cumpre.
import type { Op, ImportDay, ImportPlan } from './schemas.ts'
import { normalizeText } from './schemas.ts'
import type { AppData, MealLog, PlanMeal, PlanWorkout, WorkoutKind, WorkoutLog } from './types.ts'
import { expandDay, type DayWorkout } from './calc.ts'

export const uuid = (): string => crypto.randomUUID()

function upsertBy<T extends { id: string }>(list: T[], row: T, sameKey?: (a: T) => boolean): T[] {
  const idx = list.findIndex((x) => x.id === row.id || (sameKey ? sameKey(x) : false))
  if (idx === -1) return [...list, row]
  const copy = list.slice()
  copy[idx] = row
  return copy
}

/** Aplica uma operação em memória. Espelha o que /api/mutate faz no banco. */
export function applyOp(data: AppData, op: Op): AppData {
  switch (op.t) {
    case 'meal_log.upsert': {
      const r = op.row as MealLog
      return {
        ...data,
        meal_logs: upsertBy(data.meal_logs, r, (x) =>
          r.plan_meal_id != null && x.date === r.date && x.plan_meal_id === r.plan_meal_id,
        ),
      }
    }
    case 'meal_log.delete':
      return { ...data, meal_logs: data.meal_logs.filter((x) => x.id !== op.id) }
    case 'workout_log.upsert': {
      const r = op.row as WorkoutLog
      return {
        ...data,
        workout_logs: upsertBy(data.workout_logs, r, (x) =>
          r.plan_workout_id != null && x.date === r.date && x.plan_workout_id === r.plan_workout_id,
        ),
      }
    }
    case 'workout_log.delete':
      return { ...data, workout_logs: data.workout_logs.filter((x) => x.id !== op.id) }
    case 'workout_log.assign': {
      const log = data.workout_logs.find((x) => x.id === op.id)
      if (!log) return data
      const plan = data.plan_workouts.find((w) => w.id === op.plan_workout_id)
      const others = data.workout_logs.filter(
        (x) => x.id === op.id || !(op.plan_workout_id && x.date === log.date && x.plan_workout_id === op.plan_workout_id),
      )
      return {
        ...data,
        workout_logs: others.map((x) =>
          x.id === op.id
            ? { ...x, plan_workout_id: op.plan_workout_id, name: plan?.name ?? x.name, done: true }
            : x,
        ),
      }
    }
    case 'extra.upsert':
      return { ...data, extras: upsertBy(data.extras, op.row) }
    case 'extra.delete':
      return { ...data, extras: data.extras.filter((x) => x.id !== op.id) }
    case 'override.upsert': {
      const r = op.row
      // Só uma troca por treino/data de origem.
      const rest = data.overrides.filter(
        (x) => x.id === r.id || !(x.plan_workout_id === r.plan_workout_id && x.from_date === r.from_date),
      )
      return { ...data, overrides: upsertBy(rest, r) }
    }
    case 'override.delete':
      return { ...data, overrides: data.overrides.filter((x) => x.id !== op.id) }
    case 'plan_meal.upsert':
      return { ...data, plan_meals: upsertBy(data.plan_meals, op.row) }
    case 'plan_meal.delete':
      return { ...data, plan_meals: data.plan_meals.filter((x) => x.id !== op.id) }
    case 'plan_workout.upsert':
      return { ...data, plan_workouts: upsertBy(data.plan_workouts, op.row) }
    case 'plan_workout.delete':
      return {
        ...data,
        plan_workouts: data.plan_workouts.filter((x) => x.id !== op.id),
        overrides: data.overrides.filter((x) => x.plan_workout_id !== op.id),
      }
    case 'settings.update':
      return { ...data, settings: { ...data.settings, ...op.row } }
  }
}

/** Expande o JSON de plano em linhas (uma por dia da semana). */
export function importPlanToRows(plan: ImportPlan): { meals: PlanMeal[]; workouts: PlanWorkout[] } {
  const meals: PlanMeal[] = []
  plan.meals.forEach((m, i) => {
    for (const weekday of m.weekdays) {
      meals.push({
        id: uuid(),
        weekday,
        name: m.name,
        time: m.time,
        description: m.description,
        items: m.items,
        kcal: m.kcal,
        protein: m.protein,
        carbs: m.carbs,
        fat: m.fat,
        sort: i,
      })
    }
  })
  const workouts: PlanWorkout[] = []
  plan.workouts.forEach((w, i) => {
    for (const weekday of w.weekdays) {
      workouts.push({
        id: uuid(),
        weekday,
        name: w.name,
        kind: w.kind,
        time: w.time,
        details: w.details,
        exercises: w.exercises,
        duration_min: w.duration_min,
        kcal: w.kcal,
        sort: i,
      })
    }
  })
  return { meals, workouts }
}

function sameName(a: string, b: string): boolean {
  const x = normalizeText(a)
  const y = normalizeText(b)
  return x === y || x.includes(y) || y.includes(x)
}

/** Converte o JSON "lançamentos do dia" em operações, casando nomes com o plano do dia. */
export function importDayToOps(day: ImportDay, data: AppData): Op[] {
  const view = expandDay(day.date, data)
  const ops: Op[] = []

  for (const m of day.meals) {
    const match = view.meals.find((x) => x.plan && sameName(x.name, m.name))
    const existing = match?.log
    ops.push({
      t: 'meal_log.upsert',
      row: {
        id: existing?.id ?? uuid(),
        date: day.date,
        plan_meal_id: match?.plan?.id ?? null,
        meal_name: match?.plan?.name ?? m.name,
        done: m.done,
        kcal_planned: match?.plan?.kcal ?? null,
        kcal_real: m.kcal ?? existing?.kcal_real ?? null,
        note: m.note || existing?.note || '',
        photo_path: existing?.photo_path ?? null,
        ai_estimate: existing?.ai_estimate ?? null,
      },
    })
  }

  for (const e of day.extras) {
    ops.push({ t: 'extra.upsert', row: { id: uuid(), date: day.date, ...e } })
  }

  const used = new Set<string>()
  for (const w of day.workouts) {
    const match = view.workouts.find(
      (x) => x.plan && !used.has(x.plan.id) && sameName(x.plan.name, w.name),
    )
    if (match?.plan) used.add(match.plan.id)
    const existing = match?.log
    ops.push({
      t: 'workout_log.upsert',
      row: {
        id: existing?.id ?? uuid(),
        date: day.date,
        plan_workout_id: match?.plan?.id ?? null,
        name: match?.plan?.name ?? w.name,
        done: w.done,
        duration_min: w.duration_min ?? existing?.duration_min ?? match?.plan?.duration_min ?? null,
        kcal: w.kcal ?? existing?.kcal ?? match?.plan?.kcal ?? null,
        distance_m: w.distance_km != null ? Math.round(w.distance_km * 1000) : (existing?.distance_m ?? null),
        avg_hr: w.avg_hr ?? existing?.avg_hr ?? null,
        note: w.note || existing?.note || '',
        source: existing?.source === 'strava' ? 'strava' : 'import',
        strava_activity_id: existing?.strava_activity_id ?? null,
      },
    })
  }
  return ops
}

const RUN_TYPES = ['Run', 'TrailRun', 'VirtualRun', 'Walk', 'Hike']

export function stravaKind(sportType: string): WorkoutKind {
  if (RUN_TYPES.includes(sportType)) return 'run'
  if (['WeightTraining'].includes(sportType)) return 'strength'
  if (['Crossfit', 'HighIntensityIntervalTraining', 'Workout'].includes(sportType)) return 'hyrox'
  return 'other'
}

/**
 * Escolhe qual treino previsto do dia uma atividade do Strava cumpre:
 * primeiro um ainda não feito do mesmo tipo, depois qualquer um ainda não feito.
 * Devolve null se nada combinar (vira treino avulso, que dá para atribuir na tela).
 */
export function pickWorkoutForActivity(workouts: DayWorkout[], sportType: string): DayWorkout | null {
  const kind = stravaKind(sportType)
  const open = workouts.filter((w) => w.plan && !(w.log?.done && w.log.source === 'strava'))
  const notDone = open.filter((w) => !w.log?.done)
  const sameKind = (w: DayWorkout) => {
    const k = w.plan!.kind
    if (kind === 'run') return k === 'run'
    if (kind === 'strength' || kind === 'hyrox') return k === 'strength' || k === 'hyrox'
    return false
  }
  return (
    notDone.find(sameKind) ??
    open.find(sameKind) ??
    (kind === 'other' ? (notDone[0] ?? null) : null)
  )
}
