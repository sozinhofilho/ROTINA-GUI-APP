// Casos de uso do conector MCP. Não há regra de negócio aqui: tudo usa
// expandDay/summarize (cálculos do app), importDayToOps/diffPlan (importação do app)
// e as mesmas operações (Op) que o app grava. Cada função devolve { text, data }.
import { currentStreak, expandDay, mealKcal, summarize, workoutKcal, type DayView } from '../../shared/calc.ts'
import { addDays, diffDays, formatBR, formatDayLabel, monthEnd, monthStart, todayISO, weekdayOf, WEEKDAY_SHORT, weekStart } from '../../shared/dates.ts'
import { stableId } from '../../shared/ids.ts'
import { applyOp, extraId, importDayToOps, PlanError, pruneNoops, sameName } from '../../shared/logic.ts'
import { diffPlan, formatWeekdays } from '../../shared/plan.ts'
import { review, reviewText, weeklySeries } from '../../shared/review.ts'
import {
  formatZodError,
  ImportDaySchema,
  ImportPlanSchema,
  normalizeText,
  type ImportDay,
  type Op,
} from '../../shared/schemas.ts'
import type { AppData, ExtraCategory, WorkoutKind, WorkoutLog, WorkoutSource } from '../../shared/types.ts'
import type { Store } from './store.ts'

export class ToolError extends Error {}

export interface ToolContext {
  store: Store
  now: () => Date
  /** Gera o link assinado de exportação. */
  exportUrl: (from: string, to: string, format: 'xlsx' | 'csv') => { url: string; expires_at: string }
}

export interface ToolResult {
  text: string
  data: Record<string, unknown>
}

const TZ = 'America/Sao_Paulo'
export const today = (ctx: ToolContext) => todayISO(TZ, ctx.now())
const n = (v: number) => v.toLocaleString('pt-BR')
const STATUS_TXT = { vazio: 'nada registrado', abaixo: 'abaixo da meta', dentro: 'dentro da meta', acima: 'acima da meta' }

// ---------------- leitura ----------------

function dayData(view: DayView) {
  const s = view.stats
  return {
    date: view.date,
    weekday: WEEKDAY_SHORT[weekdayOf(view.date)],
    totals: {
      kcal_in: s.kcalIn,
      kcal_extras: s.kcalExtras,
      kcal_planned: s.kcalPlanned,
      goal: s.goal,
      goal_min: s.min,
      goal_max: s.max,
      status: s.status,
      in_goal: s.inGoal,
      kcal_workouts: s.kcalWorkouts,
      base_expenditure: s.base,
      kcal_spent: s.spent,
      balance: s.balance,
      protein_done_g: s.proteinDone,
      protein_planned_g: s.proteinPlanned,
      meals_done: s.mealsDone,
      meals_total: s.mealsTotal,
      workouts_done: s.workoutsDone,
      workouts_planned: s.workoutsPlanned,
      water_ml: s.waterMl,
      water_goal_ml: s.waterGoal,
      water_ok: s.waterOk,
      weight_kg: s.weightKg,
    },
    meals: view.meals.map((m) => ({
      meal_id: m.plan?.id ?? null,
      log_id: m.log?.id ?? null,
      name: m.name,
      time: m.time,
      done: !!m.log?.done,
      kcal_planned: m.plan?.kcal ?? m.log?.kcal_planned ?? null,
      kcal_real: m.log?.kcal_real ?? null,
      kcal_counted: m.log?.done ? mealKcal(m.log, m.plan) : 0,
      protein_g: m.plan?.protein ?? null,
      carbs_g: m.plan?.carbs ?? null,
      fat_g: m.plan?.fat ?? null,
      foods: m.plan?.items.map((i) => `${i.food} ${i.qty}`).join(', ') ?? '',
      note: m.log?.note ?? '',
      in_plan: !!m.plan,
    })),
    workouts: view.workouts.map((w) => ({
      workout_id: w.plan?.id ?? null,
      log_id: w.log?.id ?? null,
      name: w.log?.name || w.name,
      type: w.plan?.kind ?? null,
      done: !!w.log?.done,
      duration_min: w.log?.duration_min ?? w.plan?.duration_min ?? null,
      kcal: w.log?.done ? workoutKcal(w.log, w.plan) : (w.plan?.kcal ?? null),
      kcal_is_estimate: !w.log?.done || w.log.kcal == null,
      distance_km: w.log?.distance_m != null ? Math.round(w.log.distance_m / 10) / 100 : null,
      avg_pace: w.log?.avg_pace ?? null,
      avg_hr: w.log?.avg_hr ?? null,
      source: w.log?.source ?? null,
      note: w.log?.note ?? '',
      moved_from: w.movedFrom?.from_date ?? null,
      in_plan: !!w.plan,
    })),
    moved_away: view.movedAway.map((m) => ({ workout_id: m.plan.id, name: m.plan.name, to_date: m.override.to_date, move_id: m.override.id })),
    extras: view.extras.map((e) => ({ extra_id: e.id, time: e.time, description: e.description, kcal: e.kcal, category: e.category })),
  }
}

function dayText(view: DayView): string {
  const s = view.stats
  const lines = [
    `${formatDayLabel(view.date)} (${view.date}): ${n(s.kcalIn)} de ${n(s.goal)} kcal, ${STATUS_TXT[s.status]} (faixa ${n(s.min)}–${n(s.max)}).`,
    `Gasto: ${n(s.spent)} kcal${s.base != null ? ` (treinos ${n(s.kcalWorkouts)} + base ${n(s.base)}) · saldo ${s.balance! > 0 ? '+' : ''}${n(s.balance!)}` : ' em treinos'}.`,
    `Refeições ${s.mealsDone}/${s.mealsTotal}: ${view.meals.map((m) => `${m.log?.done ? '✓' : '○'} ${m.name}${m.log?.kcal_real != null ? ` (${m.log.kcal_real} kcal)` : ''}`).join(' · ') || 'nenhuma'}.`,
    `Treinos: ${view.workouts.map((w) => `${w.log?.done ? '✓' : '○'} ${w.log?.name || w.name}${w.movedFrom ? ` (movido de ${formatBR(w.movedFrom.from_date)})` : ''}`).join(' · ') || 'descanso'}.`,
  ]
  for (const m of view.movedAway) lines.push(`${m.plan.name} foi movido para ${formatBR(m.override.to_date)}.`)
  if (view.extras.length) lines.push(`Extras: ${view.extras.map((e) => `${e.description} ${e.kcal} kcal`).join(' · ')}.`)
  lines.push(`Água: ${(s.waterMl / 1000).toLocaleString('pt-BR')} de ${(s.waterGoal / 1000).toLocaleString('pt-BR')} L${s.waterOk ? ' ✓' : ''}.${s.weightKg != null ? ` Peso: ${s.weightKg.toLocaleString('pt-BR')} kg.` : ''}`)
  return lines.join('\n')
}

export async function getDay(ctx: ToolContext, a: { date?: string }): Promise<ToolResult> {
  const date = a.date ?? today(ctx)
  const data = await ctx.store.load(date, date)
  const view = expandDay(date, data)
  return { text: dayText(view), data: dayData(view) }
}

const MAX_RANGE = 400

export async function getRange(ctx: ToolContext, a: { from: string; to: string }): Promise<ToolResult> {
  if (a.from > a.to) throw new ToolError('"from" deve ser anterior ou igual a "to".')
  if (diffDays(a.from, a.to) > MAX_RANGE) throw new ToolError(`Período longo demais (máximo ${MAX_RANGE} dias).`)
  const t = today(ctx)
  const end = a.to < t ? a.to : t
  // Histórico extra para a sequência atual (mesmo limite de 120 dias da tela Resumo).
  const histFrom = addDays(end, -120) < a.from ? addDays(end, -120) : a.from
  const data = await ctx.store.load(histFrom, a.to)
  const s = summarize(a.from, a.to, data, t)
  const streak = a.from <= end ? currentStreak(data, end, 120) : 0
  const metrics = {
    from: a.from,
    to: a.to,
    days_counted: s.days,
    days_with_record: s.daysWithRecord,
    days_in_goal: s.daysInGoal,
    avg_kcal_in: s.avgKcalIn,
    avg_kcal_spent: s.avgSpent,
    avg_kcal_workouts: s.avgWorkoutKcal,
    spent_includes_base: s.hasBase,
    meals_done: s.mealsDone,
    meals_planned: s.mealsTotal,
    meals_adherence_pct: s.pctMeals,
    workouts_planned_done: s.workoutsPlannedDone,
    workouts_planned: s.workoutsPlanned,
    workouts_done_total: s.workoutsDone,
    workouts_adherence_pct: s.pctWorkouts,
    best_streak_in_goal: s.bestStreak,
    current_streak_in_goal: streak,
  }
  const days = s.daily.map((d) => ({
    date: d.date,
    kcal_in: d.kcalIn,
    status: d.status,
    in_goal: d.inGoal,
    kcal_spent: d.spent,
    balance: d.balance,
    meals_done: d.mealsDone,
    meals_total: d.mealsTotal,
    workouts_done: d.workoutsDone,
    workouts_planned: d.workoutsPlanned,
  }))
  const text = s.days === 0
    ? `${formatBR(a.from)} a ${formatBR(a.to)}: período ainda não começou.`
    : [
        `${formatBR(a.from)} a ${formatBR(a.to)} (${s.days} dias contados até hoje):`,
        `Dias na meta: ${s.daysInGoal}/${s.days} (${s.daysWithRecord} com registro). Média ingerida: ${n(s.avgKcalIn)} kcal/dia. Média de gasto: ${n(s.avgSpent)} kcal/dia${s.hasBase ? '' : ' (só treinos)'}.`,
        `Adesão: refeições ${s.pctMeals}% (${s.mealsDone}/${s.mealsTotal}), treinos ${s.pctWorkouts}% (${s.workoutsPlannedDone}/${s.workoutsPlanned}).`,
        `Sequência atual na meta: ${streak} dia(s); melhor no período: ${s.bestStreak}.`,
      ].join('\n')
  return { text, data: { metrics, days } }
}

export async function getPlan(ctx: ToolContext): Promise<ToolResult> {
  const t = today(ctx)
  const data = await ctx.store.load(t, t)
  const order = [1, 2, 3, 4, 5, 6, 0]
  const week = order.map((wd) => {
    const meals = data.plan_meals.filter((m) => m.weekday === wd).sort((a, b) => a.time.localeCompare(b.time))
    const workouts = data.plan_workouts.filter((w) => w.weekday === wd).sort((a, b) => a.sort - b.sort)
    return {
      weekday: wd,
      day: WEEKDAY_SHORT[wd],
      kcal_total: meals.reduce((s, m) => s + m.kcal, 0),
      meals: meals.map((m) => ({ meal_id: m.id, name: m.name, time: m.time, kcal: m.kcal, protein_g: m.protein, carbs_g: m.carbs, fat_g: m.fat, description: m.description, foods: m.items.map((i) => `${i.food} ${i.qty}${i.kcal != null ? ` (${i.kcal} kcal)` : ''}`) })),
      workouts: workouts.map((w) => ({ workout_id: w.id, name: w.name, type: w.kind, duration_min: w.duration_min, kcal_estimate: w.kcal, details: w.details, exercises: w.exercises.map((e) => `${e.name} ${e.sets}x${e.reps}`) })),
    }
  })
  const s = data.settings
  const text = [
    `Meta ${n(s.calorie_goal)} kcal ± ${s.tolerance_pct}%${s.base_expenditure != null ? `, gasto base ${n(s.base_expenditure)} kcal` : ''}.`,
    ...week.map((d) => `${d.day}: ${d.meals.length} refeições (${n(d.kcal_total)} kcal) · treino: ${d.workouts.map((w) => w.name).join(' + ') || 'descanso'}`),
  ].join('\n')
  return { text, data: { settings: s, week } }
}

// ---------------- escrita ----------------

async function commit(ctx: ToolContext, data: AppData, ops: Op[]): Promise<{ applied: Op[]; after: AppData }> {
  const applied = pruneNoops(ops, data)
  if (applied.length) await ctx.store.apply(applied)
  return { applied, after: applied.reduce(applyOp, data) }
}

function totalsLine(view: DayView): string {
  const s = view.stats
  return `Dia ${formatBR(view.date)}: ${n(s.kcalIn)}/${n(s.goal)} kcal (${STATUS_TXT[s.status]})${s.balance != null ? `, saldo ${s.balance > 0 ? '+' : ''}${n(s.balance)}` : ''}.`
}

function findMeal(view: DayView, ref: string) {
  const r = normalizeText(ref)
  return (
    view.meals.find((m) => m.plan?.id === ref || m.log?.id === ref) ??
    view.meals.find((m) => normalizeText(m.name) === r) ??
    view.meals.find((m) => sameName(m.name, ref))
  )
}

function findWorkout(view: DayView, ref: string) {
  const r = normalizeText(ref)
  return (
    view.workouts.find((w) => w.plan?.id === ref || w.log?.id === ref) ??
    view.workouts.find((w) => normalizeText(w.log?.name || w.name) === r) ??
    view.workouts.find((w) => sameName(w.log?.name || w.name, ref))
  )
}

const mealList = (v: DayView) => v.meals.map((m) => `${m.name} (${m.plan?.id ?? m.log?.id})`).join(', ') || 'nenhuma'
const workoutList = (v: DayView) => v.workouts.map((w) => `${w.log?.name || w.name} (${w.plan?.id ?? w.log?.id})`).join(', ') || 'nenhum'

export async function setMealDone(
  ctx: ToolContext,
  a: { date?: string; meal_id: string; done: boolean; kcal_real?: number | null; note?: string },
): Promise<ToolResult> {
  const date = a.date ?? today(ctx)
  const data = await ctx.store.load(date, date)
  const view = expandDay(date, data)
  const meal = findMeal(view, a.meal_id)
  if (!meal) throw new ToolError(`Refeição não encontrada nesse dia (${formatBR(date)}). Refeições do dia: ${mealList(view)}.`)
  const log = meal.log
  const row = {
    id: log?.id ?? stableId('meal', date, meal.plan?.id ?? meal.name),
    date,
    plan_meal_id: meal.plan?.id ?? log?.plan_meal_id ?? null,
    meal_name: meal.name,
    done: a.done,
    kcal_planned: meal.plan?.kcal ?? log?.kcal_planned ?? null,
    kcal_real: a.kcal_real === undefined ? (log?.kcal_real ?? null) : a.kcal_real,
    note: a.note ?? log?.note ?? '',
    photo_path: log?.photo_path ?? null,
    ai_estimate: log?.ai_estimate ?? null,
  }
  const { applied, after } = await commit(ctx, data, [{ t: 'meal_log.upsert', row }])
  const v2 = expandDay(date, after)
  const what = `${meal.name} ${a.done ? 'marcado como feito' : 'desmarcado'}${row.kcal_real != null ? ` (${row.kcal_real} kcal reais)` : ''}`
  return {
    text: `${applied.length ? what : `Sem mudança: ${what} já estava assim`}. ${totalsLine(v2)}`,
    data: { changed: applied.length > 0, meal_id: meal.plan?.id ?? null, log_id: row.id, day: dayData(v2).totals },
  }
}

const KIND_LABEL: Record<WorkoutKind, string> = { hyrox: 'HYROX', run: 'Corrida', strength: 'Musculação', other: 'Treino' }

export async function logWorkout(
  ctx: ToolContext,
  a: {
    date?: string
    workout_id?: string
    type: WorkoutKind
    duration_min: number
    distance_km?: number
    avg_pace?: string
    avg_hr?: number
    kcal?: number
    source?: WorkoutSource
    note?: string
  },
): Promise<ToolResult> {
  const date = a.date ?? today(ctx)
  const data = await ctx.store.load(date, date)
  const view = expandDay(date, data)
  let target = a.workout_id ? findWorkout(view, a.workout_id) : undefined
  if (a.workout_id && !target) {
    throw new ToolError(`Treino não encontrado nesse dia (${formatBR(date)}). Treinos do dia: ${workoutList(view)}. Omita workout_id para registrar um treino avulso.`)
  }
  if (!target) {
    // Sem id: usa o treino previsto do mesmo tipo ainda não feito (ou o já registrado do mesmo tipo).
    const planned = view.workouts.filter((w) => w.plan && w.plan.kind === a.type)
    target = planned.find((w) => !w.log?.done) ?? planned[0]
  }
  if (!target) {
    target = view.workouts.find((w) => !w.plan && w.log && normalizeText(w.log.name) === normalizeText(KIND_LABEL[a.type]))
  }
  const log = target?.log ?? null
  const plan = target?.plan ?? null
  const distance_m = a.distance_km != null ? Math.round(a.distance_km * 1000) : (log?.distance_m ?? null)
  const row: WorkoutLog = {
    id: log?.id ?? stableId('workout', date, plan?.id ?? KIND_LABEL[a.type]),
    date,
    plan_workout_id: plan?.id ?? null,
    name: plan?.name ?? log?.name ?? KIND_LABEL[a.type],
    done: true,
    duration_min: a.duration_min,
    kcal: a.kcal ?? log?.kcal ?? plan?.kcal ?? null,
    distance_m,
    avg_hr: a.avg_hr ?? log?.avg_hr ?? null,
    avg_pace: a.avg_pace ?? log?.avg_pace ?? null,
    note: a.note ?? log?.note ?? '',
    source: a.source ?? log?.source ?? 'manual',
    strava_activity_id: log?.strava_activity_id ?? null,
  }
  const { applied, after } = await commit(ctx, data, [{ t: 'workout_log.upsert', row }])
  const v2 = expandDay(date, after)
  const kcalNote = a.kcal == null && row.kcal != null && log?.kcal == null ? ` (${row.kcal} kcal estimadas pelo plano)` : row.kcal != null ? ` (${row.kcal} kcal)` : ''
  const what = `${row.name} registrado: ${row.duration_min} min${a.distance_km != null ? `, ${a.distance_km} km` : ''}${kcalNote}${plan ? '' : ' como treino avulso'}`
  return {
    text: `${applied.length ? what : `Sem mudança: ${what}, igual ao que já estava`}. ${totalsLine(v2)}`,
    data: { changed: applied.length > 0, workout_id: plan?.id ?? null, log_id: row.id, day: dayData(v2).totals },
  }
}

const ALCOHOL = /(cerveja|chopp?|vinho|drink|caipirinha|whisk|vodka|gin|tequila|cachaca|alcool|espumante|long neck)/

export async function addExtra(
  ctx: ToolContext,
  a: { date?: string; description: string; kcal: number; time?: string; category?: ExtraCategory },
): Promise<ToolResult> {
  const date = a.date ?? today(ctx)
  const data = await ctx.store.load(date, date)
  const time = a.time ?? null
  const category: ExtraCategory = a.category ?? (ALCOHOL.test(normalizeText(a.description)) ? 'alcool' : 'outro')
  const row = { id: extraId(date, a.description, a.kcal, time), date, time, description: a.description.trim(), kcal: a.kcal, category }
  const { applied, after } = await commit(ctx, data, [{ t: 'extra.upsert', row }])
  const v2 = expandDay(date, after)
  return {
    text: `${applied.length ? 'Extra lançado' : 'Esse extra já estava lançado (nada duplicado)'}: ${row.description}, ${row.kcal} kcal${time ? ` às ${time}` : ''}. ${totalsLine(v2)}`,
    data: { changed: applied.length > 0, extra_id: row.id, day: dayData(v2).totals },
  }
}

export async function removeEntry(
  ctx: ToolContext,
  a: { date: string; entry_type: 'meal' | 'workout' | 'extra' | 'move'; entry_id: string },
): Promise<ToolResult> {
  const data = await ctx.store.load(a.date, a.date)
  const view = expandDay(a.date, data)
  let op: Op | null = null
  let label = ''
  if (a.entry_type === 'meal') {
    const m = findMeal(view, a.entry_id)
    if (!m) throw new ToolError(`Refeição não encontrada nesse dia (${formatBR(a.date)}). Refeições do dia: ${mealList(view)}.`)
    label = `registro de ${m.name}`
    if (m.log) op = { t: 'meal_log.delete', id: m.log.id }
  } else if (a.entry_type === 'workout') {
    const w = findWorkout(view, a.entry_id)
    if (!w) throw new ToolError(`Treino não encontrado nesse dia (${formatBR(a.date)}). Treinos do dia: ${workoutList(view)}.`)
    label = `registro de ${w.log?.name || w.name}`
    if (w.log) op = { t: 'workout_log.delete', id: w.log.id }
  } else if (a.entry_type === 'extra') {
    const e = view.extras.find((x) => x.id === a.entry_id) ?? view.extras.find((x) => sameName(x.description, a.entry_id))
    if (!e) {
      return { text: `Nada a desfazer: não há esse extra em ${formatBR(a.date)}. ${totalsLine(view)}`, data: { changed: false, day: dayData(view).totals } }
    }
    label = `extra "${e.description}"`
    op = { t: 'extra.delete', id: e.id }
  } else {
    const o =
      data.overrides.find((x) => x.id === a.entry_id) ??
      data.overrides.find((x) => x.plan_workout_id === a.entry_id && (x.from_date === a.date || x.to_date === a.date))
    if (!o) {
      return { text: `Nada a desfazer: nenhuma troca de dia com esse id envolvendo ${formatBR(a.date)}.`, data: { changed: false } }
    }
    label = `troca de dia (${formatBR(o.from_date)} → ${formatBR(o.to_date)})`
    op = { t: 'override.delete', id: o.id }
  }
  const { applied, after } = await commit(ctx, data, op ? [op] : [])
  const v2 = expandDay(a.date, after)
  return {
    text: `${applied.length ? `Desfeito: ${label}` : `Nada a desfazer: ${label} não existia`}. ${totalsLine(v2)}`,
    data: { changed: applied.length > 0, day: dayData(v2).totals },
  }
}

export async function moveWorkout(
  ctx: ToolContext,
  a: { from_date: string; to_date: string; workout_id?: string },
): Promise<ToolResult> {
  if (a.from_date === a.to_date) throw new ToolError('from_date e to_date são iguais.')
  const lo = a.from_date < a.to_date ? a.from_date : a.to_date
  const hi = a.from_date < a.to_date ? a.to_date : a.from_date
  const data = await ctx.store.load(lo, hi)
  const view = expandDay(a.from_date, data)
  let items = view.workouts.filter((w) => w.plan)
  if (a.workout_id) {
    const w = findWorkout(view, a.workout_id)
    if (!w?.plan) throw new ToolError(`Treino não encontrado em ${formatBR(a.from_date)}. Treinos do dia: ${workoutList(view)}.`)
    items = [w]
  }
  if (!items.length) {
    const already = view.movedAway.filter((m) => m.override.to_date === a.to_date)
    if (already.length) {
      return { text: `Sem mudança: ${already.map((m) => m.plan.name).join(' + ')} já estava movido de ${formatBR(a.from_date)} para ${formatBR(a.to_date)}.`, data: { changed: false } }
    }
    throw new ToolError(`Não há treino previsto em ${formatBR(a.from_date)} para mover.`)
  }
  const ops: Op[] = items.map((w) => {
    // Treino que já veio de outro dia: ajusta a troca original (ou desfaz, se voltar ao dia de origem).
    const origin = w.movedFrom?.from_date ?? a.from_date
    if (w.movedFrom && origin === a.to_date) return { t: 'override.delete', id: w.movedFrom.id }
    return {
      t: 'override.upsert',
      row: { id: w.movedFrom?.id ?? stableId('move', w.plan!.id, origin), plan_workout_id: w.plan!.id, from_date: origin, to_date: a.to_date },
    }
  })
  const { applied, after } = await commit(ctx, data, ops)
  const names = items.map((w) => w.plan!.name).join(' + ')
  const far = Math.abs(diffDays(a.from_date, a.to_date)) > 6 ? ' Atenção: as datas estão em semanas diferentes.' : ''
  return {
    text: `${applied.length ? 'Movido' : 'Sem mudança, já estava movido'}: ${names} de ${formatDayLabel(a.from_date)} para ${formatDayLabel(a.to_date)} (só nesta data; o plano padrão não muda).${far}`,
    data: {
      changed: applied.length > 0,
      moved: items.map((w) => ({ workout_id: w.plan!.id, name: w.plan!.name, from_date: w.movedFrom?.from_date ?? a.from_date, to_date: a.to_date })),
      from_day: dayData(expandDay(a.from_date, after)).workouts,
      to_day: dayData(expandDay(a.to_date, after)).workouts,
    },
  }
}

function parseJsonArg(v: unknown, field: string): unknown {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch (e) {
    throw new ToolError(`${field} não é um JSON válido: ${(e as Error).message}`)
  }
}

export async function updatePlan(ctx: ToolContext, a: { plan_json: unknown; confirm?: boolean }): Promise<ToolResult> {
  const parsed = ImportPlanSchema.safeParse(parseJsonArg(a.plan_json, 'plan_json'))
  if (!parsed.success) throw new ToolError(`Plano inválido:\n${formatZodError(parsed.error)}`)
  const t = today(ctx)
  const data = await ctx.store.load(t, t)
  let diff
  try {
    diff = diffPlan(data, parsed.data)
  } catch (err) {
    if (err instanceof PlanError) throw new ToolError(`Plano inválido: ${err.message}`)
    throw err
  }
  const preview = { changes: diff.changes.map((c) => ({ ...c, days: formatWeekdays(c.weekdays) })), settings: diff.settings, operations: diff.ops.length }
  if (!a.confirm || diff.ops.length === 0) {
    const tail = diff.ops.length ? '\n\nNada foi gravado. Para aplicar, chame de novo com confirm=true.' : ''
    return { text: `Prévia do plano (${parsed.data.replace ? 'substituir' : 'adicionar'}):\n${diff.summary}${tail}`, data: { confirmed: false, ...preview } }
  }
  await ctx.store.apply(diff.ops)
  return { text: `Plano atualizado (${diff.ops.length} alteração(ões)):\n${diff.summary}`, data: { confirmed: true, ...preview } }
}

function describeOp(op: Op): string {
  switch (op.t) {
    case 'meal_log.upsert':
      return `${formatBR(op.row.date)} · ${op.row.meal_name}: ${op.row.done ? 'feita' : 'não feita'}${op.row.kcal_real != null ? `, ${op.row.kcal_real} kcal reais` : ''}${op.row.plan_meal_id ? '' : ' (fora do plano)'}`
    case 'workout_log.upsert':
      return `${formatBR(op.row.date)} · treino ${op.row.name}: ${op.row.done ? 'feito' : 'não feito'}${op.row.duration_min != null ? `, ${op.row.duration_min} min` : ''}${op.row.kcal != null ? `, ${op.row.kcal} kcal` : ''}${op.row.plan_workout_id ? '' : ' (avulso)'}`
    case 'extra.upsert':
      return `${formatBR(op.row.date)} · extra: ${op.row.description}, ${op.row.kcal} kcal`
    default:
      return `${op.t}${'id' in op ? ` ${op.id}` : ''}`
  }
}

export async function importJson(ctx: ToolContext, a: { payload: unknown; confirm?: boolean }): Promise<ToolResult> {
  const raw = parseJsonArg(a.payload, 'payload')
  const looksLikePlan =
    raw && typeof raw === 'object' && !Array.isArray(raw) && !('date' in raw) &&
    ('replace' in raw || 'settings' in raw || 'meals' in raw || 'workouts' in raw)
  if (looksLikePlan) return updatePlan(ctx, { plan_json: raw, confirm: a.confirm })

  const list = Array.isArray(raw) ? raw : [raw]
  if (!list.length || list.length > 31) throw new ToolError('payload deve ter de 1 a 31 dias.')
  const days: ImportDay[] = []
  for (const [i, d] of list.entries()) {
    const r = ImportDaySchema.safeParse(d)
    if (!r.success) throw new ToolError(`Lançamentos inválidos${list.length > 1 ? ` (item ${i})` : ''}:\n${formatZodError(r.error)}`)
    days.push(r.data)
  }
  const dates = days.map((d) => d.date).sort()
  let data = await ctx.store.load(dates[0], dates[dates.length - 1])
  const ops: Op[] = []
  for (const d of days) {
    const dayOps = importDayToOps(d, data)
    ops.push(...dayOps)
    data = dayOps.reduce(applyOp, data)
  }
  const lines = ops.map((op) => `• ${describeOp(op)}`)
  if (!ops.length) return { text: 'Nenhuma mudança: esses lançamentos já estão registrados.', data: { confirmed: false, operations: 0 } }
  if (!a.confirm) {
    return {
      text: `Prévia (${ops.length} alteração(ões)):\n${lines.join('\n')}\n\nNada foi gravado. Para aplicar, chame de novo com confirm=true.`,
      data: { confirmed: false, operations: ops.length, changes: lines },
    }
  }
  await ctx.store.apply(ops)
  const totals = days.map((d) => ({ date: d.date, ...dayData(expandDay(d.date, data)).totals }))
  return {
    text: `Importado (${ops.length} alteração(ões)):\n${lines.join('\n')}\n${days.map((d) => totalsLine(expandDay(d.date, data))).join('\n')}`,
    data: { confirmed: true, operations: ops.length, changes: lines, days: totals },
  }
}

export async function getExport(ctx: ToolContext, a: { from: string; to: string; format?: 'xlsx' | 'csv' }): Promise<ToolResult> {
  if (a.from > a.to) throw new ToolError('"from" deve ser anterior ou igual a "to".')
  if (diffDays(a.from, a.to) > 800) throw new ToolError('Período longo demais (máximo ~2 anos).')
  const format = a.format ?? 'xlsx'
  const link = ctx.exportUrl(a.from, a.to, format)
  return {
    text: `Link para baixar o ${format.toUpperCase()} de ${formatBR(a.from)} a ${formatBR(a.to)} (válido até ${link.expires_at}):\n${link.url}`,
    data: { url: link.url, expires_at: link.expires_at, format },
  }
}

// ---------------- peso, água e fechamento ----------------

export async function logWeight(ctx: ToolContext, a: { date?: string; weight_kg: number; note?: string }): Promise<ToolResult> {
  const date = a.date ?? today(ctx)
  const data = await ctx.store.load(addDays(date, -14), date)
  const existing = (data.body ?? []).find((b) => b.date === date)
  const row = {
    id: existing?.id ?? stableId('body', date),
    date,
    weight_kg: Math.round(a.weight_kg * 10) / 10,
    photo_front: existing?.photo_front ?? null,
    photo_side: existing?.photo_side ?? null,
    note: a.note ?? existing?.note ?? '',
  }
  const { applied } = await commit(ctx, data, [{ t: 'body.upsert', row }])
  const prev = (data.body ?? []).filter((b) => b.date < date && b.weight_kg != null).sort((x, y) => y.date.localeCompare(x.date))[0]
  const delta = prev?.weight_kg != null ? Math.round((row.weight_kg - prev.weight_kg) * 10) / 10 : null
  const wd = weekdayOf(date)
  const hint = wd === 1 || wd === 5 ? '' : ' (o combinado é pesar na segunda e na sexta)'
  const vs = delta != null ? ` ${delta > 0 ? '+' : delta < 0 ? '−' : ''}${Math.abs(delta).toLocaleString('pt-BR')} kg vs ${formatBR(prev!.date)}.` : ''
  return {
    text: `${applied.length ? 'Peso registrado' : 'Sem mudança, já estava registrado'}: ${row.weight_kg.toLocaleString('pt-BR')} kg em ${formatDayLabel(date)}${hint}.${vs} As fotos são enviadas pelo app.`,
    data: { changed: applied.length > 0, date, weight_kg: row.weight_kg, previous: prev ? { date: prev.date, weight_kg: prev.weight_kg } : null, delta_kg: delta },
  }
}

export async function addWater(ctx: ToolContext, a: { date?: string; add_ml?: number; total_ml?: number }): Promise<ToolResult> {
  if (a.add_ml == null && a.total_ml == null) throw new ToolError('Informe add_ml (somar ao dia) ou total_ml (total do dia).')
  const date = a.date ?? today(ctx)
  const data = await ctx.store.load(date, date)
  const current = (data.water ?? []).find((w) => w.date === date)?.ml ?? 0
  const ml = Math.max(0, Math.min(20000, a.total_ml ?? current + (a.add_ml ?? 0)))
  const { applied, after } = await commit(ctx, data, [{ t: 'water.set', row: { date, ml } }])
  const s = expandDay(date, after).stats
  const L = (v: number) => (v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })
  return {
    text: `${applied.length ? 'Água atualizada' : 'Sem mudança'}: ${L(ml)} de ${L(s.waterGoal)} L em ${formatBR(date)}${s.waterOk ? ' ✓ meta batida' : `, faltam ${L(s.waterGoal - ml)} L`}.`,
    data: { changed: applied.length > 0, date, water_ml: ml, water_goal_ml: s.waterGoal, water_ok: s.waterOk },
  }
}

export async function getReview(ctx: ToolContext, a: { period: 'week' | 'month' | 'all'; date?: string }): Promise<ToolResult> {
  const t = today(ctx)
  const ref = a.date ?? t
  let from: string
  let to: string
  if (a.period === 'week') {
    from = weekStart(ref)
    to = addDays(from, 6)
  } else if (a.period === 'month') {
    from = monthStart(ref)
    to = monthEnd(ref)
  } else {
    // Acumulado: desde o primeiro registro (no máximo 2 anos).
    const all = await ctx.store.load(addDays(t, -730), t)
    const dates = [...all.meal_logs, ...all.workout_logs, ...all.extras, ...(all.water ?? []), ...(all.body ?? [])].map((x) => x.date).sort()
    from = weekStart(dates[0] ?? t)
    to = t
  }
  const data = await ctx.store.load(addDays(from, -7), to > t ? to : t)
  const unit = a.period === 'week' ? 'Semana' : a.period === 'month' ? 'Mês' : 'Período'
  const r = review(from, to, data, t, unit)
  const weeks = a.period === 'week' ? [] : weeklySeries(from, to, data, t)
  const title = a.period === 'week' ? `Semana ${formatBR(from)} a ${formatBR(to)}` : a.period === 'month' ? `Mês ${from.slice(5, 7)}/${from.slice(0, 4)}` : `Acumulado desde ${formatBR(from)}`
  return {
    text: reviewText(r, title),
    data: {
      from, to, days: r.days, score: r.score, verdict: r.verdict,
      pillars: r.pillars, avg_kcal_in: r.avgKcalIn, goal: r.goal, days_above: r.daysAbove, days_below: r.daysBelow,
      extras_kcal: r.extrasKcal, alcohol_kcal: r.alcoholKcal, avg_water_ml: r.avgWaterMl,
      weights: r.weights, weight_delta_kg: r.weightDelta, weight_changes: r.weightChanges,
      wins: r.wins, misses: r.misses,
      weeks: weeks.map((w) => ({ week_start: w.weekStart, score: w.score, days_in_goal: w.daysInGoal, days: w.days, avg_kcal_in: w.avgKcalIn, weight_kg: w.weightKg })),
    },
  }
}
