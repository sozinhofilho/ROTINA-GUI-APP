// Lógica pura compartilhada: aplicar operações localmente (otimista/offline),
// converter importações em operações e escolher qual treino uma atividade cumpre.
import type { Op, ImportDay, ImportMealInput, ImportPlan, ImportWorkoutInput } from './schemas.ts'
import { normalizeText } from './schemas.ts'
import type { AppData, MealLog, PlanMeal, PlanWorkout, WorkoutKind, WorkoutLog } from './types.ts'
import { expandDay, type DayWorkout } from './calc.ts'
import { stableId } from './ids.ts'

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
    case 'meal_log.patch': {
      const ex = findMealLog(data, op)
      const row: MealLog = ex
        ? { ...ex, ...op.set }
        : { id: op.id, date: op.date, plan_meal_id: op.plan_meal_id, meal_name: op.meal_name, done: false, kcal_planned: op.kcal_planned, kcal_real: null, note: '', photo_path: null, ai_estimate: null, ...op.set }
      return { ...data, meal_logs: [...data.meal_logs.filter((x) => x !== ex), row] }
    }
    case 'workout_log.patch': {
      const ex = findWorkoutLog(data, op)
      const row: WorkoutLog = ex
        ? { ...ex, ...op.set }
        : { id: op.id, date: op.date, plan_workout_id: op.plan_workout_id, name: op.name, done: false, duration_min: null, kcal: null, distance_m: null, avg_hr: null, avg_pace: null, note: '', source: 'manual', strava_activity_id: null, ...op.set }
      return { ...data, workout_logs: [...data.workout_logs.filter((x) => x !== ex), row] }
    }
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
    case 'water.set': {
      const rest = (data.water ?? []).filter((w) => w.date !== op.row.date)
      return { ...data, water: op.row.ml > 0 ? [...rest, op.row] : rest }
    }
    case 'body.upsert': {
      const r = op.row
      const rest = (data.body ?? []).filter((b) => b.id !== r.id && b.date !== r.date)
      return { ...data, body: [...rest, r] }
    }
    case 'body.delete':
      return { ...data, body: (data.body ?? []).filter((b) => b.id !== op.id) }
  }
}

export class PlanError extends Error {}

/** Monta uma refeição do plano a partir do JSON; `base` (item existente) preenche o que foi omitido. */
export function buildPlanMeal(m: ImportMealInput, weekday: number, sort: number, base?: PlanMeal): PlanMeal {
  const time = m.time ?? base?.time
  const kcal = m.kcal ?? base?.kcal
  if (time === undefined || kcal === undefined) throw new PlanError(`refeição "${m.name}": informe time e kcal (item novo)`)
  return {
    id: base?.id ?? uuid(),
    weekday,
    name: m.name,
    time,
    description: m.description ?? base?.description ?? '',
    items: m.items ?? base?.items ?? [],
    kcal,
    protein: m.protein !== undefined ? m.protein : (base?.protein ?? null),
    carbs: m.carbs !== undefined ? m.carbs : (base?.carbs ?? null),
    fat: m.fat !== undefined ? m.fat : (base?.fat ?? null),
    sort,
  }
}

export function buildPlanWorkout(w: ImportWorkoutInput, weekday: number, sort: number, base?: PlanWorkout): PlanWorkout {
  const pick = <K extends keyof PlanWorkout>(k: K, fallback: PlanWorkout[K]): PlanWorkout[K] =>
    (w as Record<string, unknown>)[k] !== undefined ? ((w as Record<string, unknown>)[k] as PlanWorkout[K]) : base ? base[k] : fallback
  return {
    id: base?.id ?? uuid(),
    weekday,
    name: w.name,
    kind: pick('kind', 'other'),
    time: pick('time', null),
    details: pick('details', ''),
    exercises: pick('exercises', []),
    duration_min: pick('duration_min', null),
    kcal: pick('kcal', null),
    sort,
  }
}

/** Expande o JSON de plano em linhas novas (uma por dia da semana). */
export function importPlanToRows(plan: ImportPlan): { meals: PlanMeal[]; workouts: PlanWorkout[] } {
  const meals = plan.meals.flatMap((m, i) => m.weekdays.map((wd) => buildPlanMeal(m, wd, i)))
  const workouts = plan.workouts.flatMap((w, i) => w.weekdays.map((wd) => buildPlanWorkout(w, wd, i)))
  return { meals, workouts }
}

export function sameName(a: string, b: string): boolean {
  const x = normalizeText(a)
  const y = normalizeText(b)
  return x === y || x.includes(y) || y.includes(x)
}

/** Converte o JSON "lançamentos do dia" em operações, casando nomes com o plano do dia. */
export function importDayToOps(day: ImportDay, data: AppData): Op[] {
  const view = expandDay(day.date, data)
  const ops: Op[] = []

  for (const m of day.meals) {
    const match =
      view.meals.find((x) => x.plan && normalizeText(x.name) === normalizeText(m.name)) ??
      view.meals.find((x) => x.plan && sameName(x.name, m.name))
    const orphan = !match ? view.meals.find((x) => !x.plan && x.log && normalizeText(x.name) === normalizeText(m.name)) : undefined
    const existing = match?.log ?? orphan?.log
    ops.push({
      t: 'meal_log.upsert',
      row: {
        id: existing?.id ?? stableId('meal', day.date, match?.plan?.id ?? m.name),
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
    // Mesmo extra (data, descrição, kcal, horário) = mesmo id: reimportar não duplica.
    ops.push({ t: 'extra.upsert', row: { id: extraId(day.date, e.description, e.kcal, e.time), date: day.date, ...e } })
  }

  const used = new Set<string>()
  for (const w of day.workouts) {
    const match = view.workouts.find(
      (x) => x.plan && !used.has(x.plan.id) && sameName(x.plan.name, w.name),
    )
    if (match?.plan) used.add(match.plan.id)
    const orphan = !match
      ? view.workouts.find((x) => !x.plan && x.log && normalizeText(x.log.name) === normalizeText(w.name))
      : undefined
    const existing = match?.log ?? orphan?.log
    ops.push({
      t: 'workout_log.upsert',
      row: {
        id: existing?.id ?? stableId('workout', day.date, match?.plan?.id ?? w.name),
        date: day.date,
        plan_workout_id: match?.plan?.id ?? null,
        name: match?.plan?.name ?? w.name,
        done: w.done,
        duration_min: w.duration_min ?? existing?.duration_min ?? match?.plan?.duration_min ?? null,
        kcal: w.kcal ?? existing?.kcal ?? match?.plan?.kcal ?? null,
        distance_m: w.distance_km != null ? Math.round(w.distance_km * 1000) : (existing?.distance_m ?? null),
        avg_hr: w.avg_hr ?? existing?.avg_hr ?? null,
        avg_pace: w.avg_pace ?? existing?.avg_pace ?? null,
        note: w.note || existing?.note || '',
        source: existing?.source === 'strava' ? 'strava' : 'import',
        strava_activity_id: existing?.strava_activity_id ?? null,
      },
    })
  }
  return pruneNoops(ops, data)
}

type MealPatch = Extract<Op, { t: 'meal_log.patch' }>
type WorkoutPatch = Extract<Op, { t: 'workout_log.patch' }>

export function findMealLog(data: AppData, op: Pick<MealPatch, 'id' | 'date' | 'plan_meal_id'>): MealLog | undefined {
  return data.meal_logs.find((x) => x.id === op.id) ??
    (op.plan_meal_id ? data.meal_logs.find((x) => x.date === op.date && x.plan_meal_id === op.plan_meal_id) : undefined)
}

export function findWorkoutLog(data: AppData, op: Pick<WorkoutPatch, 'id' | 'date' | 'plan_workout_id'>): WorkoutLog | undefined {
  return data.workout_logs.find((x) => x.id === op.id) ??
    (op.plan_workout_id ? data.workout_logs.find((x) => x.date === op.date && x.plan_workout_id === op.plan_workout_id) : undefined)
}

export function extraId(date: string, description: string, kcal: number, time: string | null): string {
  return stableId('extra', date, description, kcal, time)
}

function sameRow(a: object, b: object): boolean {
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  return Object.keys(x).every((k) => k === 'id' || JSON.stringify(x[k] ?? null) === JSON.stringify(y[k] ?? null))
}

/** Remove operações que não mudariam nada (base da idempotência e das prévias). */
export function pruneNoops(ops: Op[], data: AppData): Op[] {
  const out: Op[] = []
  let cur = data
  for (const op of ops) {
    if (!isNoop(op, cur)) {
      out.push(op)
      cur = applyOp(cur, op)
    }
  }
  return out
}

export function isNoop(op: Op, data: AppData): boolean {
  switch (op.t) {
    case 'meal_log.upsert': {
      const r = op.row
      const ex = data.meal_logs.find((x) => x.id === r.id || (r.plan_meal_id != null && x.date === r.date && x.plan_meal_id === r.plan_meal_id))
      return !!ex && sameRow(r, ex)
    }
    case 'workout_log.upsert': {
      const r = op.row
      const ex = data.workout_logs.find((x) => x.id === r.id || (r.plan_workout_id != null && x.date === r.date && x.plan_workout_id === r.plan_workout_id))
      return !!ex && sameRow(r, ex)
    }
    case 'extra.upsert': {
      const ex = data.extras.find((x) => x.id === op.row.id)
      return !!ex && sameRow(op.row, ex)
    }
    case 'override.upsert': {
      const ex = data.overrides.find((x) => x.plan_workout_id === op.row.plan_workout_id && x.from_date === op.row.from_date)
      return !!ex && ex.to_date === op.row.to_date
    }
    case 'plan_meal.upsert': {
      const ex = data.plan_meals.find((x) => x.id === op.row.id)
      return !!ex && sameRow(op.row, ex)
    }
    case 'plan_workout.upsert': {
      const ex = data.plan_workouts.find((x) => x.id === op.row.id)
      return !!ex && sameRow(op.row, ex)
    }
    case 'settings.update': {
      const s = data.settings as unknown as Record<string, unknown>
      return Object.entries(op.row).every(([k, v]) => s[k] === v)
    }
    case 'water.set':
      return ((data.water ?? []).find((w) => w.date === op.row.date)?.ml ?? 0) === op.row.ml
    case 'body.upsert': {
      const ex = (data.body ?? []).find((b) => b.id === op.row.id || b.date === op.row.date)
      return !!ex && sameRow(op.row, ex)
    }
    case 'body.delete':
      return !(data.body ?? []).some((b) => b.id === op.id)
    case 'meal_log.delete':
      return !data.meal_logs.some((x) => x.id === op.id)
    case 'meal_log.patch': {
      const ex = findMealLog(data, op) as unknown as Record<string, unknown> | undefined
      return !!ex && Object.entries(op.set).every(([k, v]) => JSON.stringify(ex[k] ?? null) === JSON.stringify(v ?? null))
    }
    case 'workout_log.patch': {
      const ex = findWorkoutLog(data, op) as unknown as Record<string, unknown> | undefined
      return !!ex && Object.entries(op.set).every(([k, v]) => JSON.stringify(ex[k] ?? null) === JSON.stringify(v ?? null))
    }
    case 'workout_log.delete':
      return !data.workout_logs.some((x) => x.id === op.id)
    case 'extra.delete':
      return !data.extras.some((x) => x.id === op.id)
    case 'override.delete':
      return !data.overrides.some((x) => x.id === op.id)
    case 'plan_meal.delete':
      return !data.plan_meals.some((x) => x.id === op.id)
    case 'plan_workout.delete':
      return !data.plan_workouts.some((x) => x.id === op.id)
    case 'workout_log.assign': {
      const ex = data.workout_logs.find((x) => x.id === op.id)
      return !ex || (ex.plan_workout_id === op.plan_workout_id && ex.done)
    }
  }
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
