// Diferença entre o plano atual e um plano novo (JSON de importação).
// Casa itens por dia da semana + nome e mantém os ids existentes, então:
// - reimportar o mesmo plano não muda nada (idempotente);
// - o histórico de registros continua ligado às mesmas refeições/treinos.
import { WEEKDAY_SHORT } from './dates.ts'
import { buildPlanMeal, buildPlanWorkout, pruneNoops } from './logic.ts'
import { normalizeText, type ImportPlan, type Op } from './schemas.ts'
import type { AppData, PlanMeal, PlanWorkout, Settings } from './types.ts'

export interface PlanChange {
  kind: 'add' | 'update' | 'remove'
  what: 'refeição' | 'treino'
  name: string
  weekdays: number[]
  details: string
}

export interface PlanDiff {
  ops: Op[]
  changes: PlanChange[]
  settings: { field: keyof Settings; from: unknown; to: unknown }[]
  summary: string
}

const MEAL_FIELDS: (keyof PlanMeal)[] = ['time', 'kcal', 'protein', 'carbs', 'fat', 'description', 'items', 'sort']
const WORKOUT_FIELDS: (keyof PlanWorkout)[] = ['kind', 'time', 'duration_min', 'kcal', 'details', 'exercises', 'sort']
const LABEL: Record<string, string> = {
  time: 'horário', kcal: 'kcal', protein: 'proteína', carbs: 'carbo', fat: 'gordura', description: 'descrição',
  items: 'alimentos', kind: 'tipo', duration_min: 'duração', details: 'detalhes', exercises: 'exercícios',
}
const SIMPLE = new Set(['time', 'kcal', 'protein', 'carbs', 'fat', 'kind', 'duration_min'])

function fieldChanges<T extends object>(cur: T, next: T, fields: (keyof T)[]): string[] {
  const out: string[] = []
  for (const f of fields) {
    const a = JSON.stringify(cur[f] ?? null)
    const b = JSON.stringify(next[f] ?? null)
    if (a === b || f === 'sort') continue
    const key = String(f)
    out.push(SIMPLE.has(key) ? `${LABEL[key]} ${cur[f] ?? '–'} → ${next[f] ?? '–'}` : `${LABEL[key]} alterados`)
  }
  return out
}

function sortChanged<T extends { sort: number }>(cur: T, next: T): boolean {
  return cur.sort !== next.sort
}

interface Incoming<T> {
  weekday: number
  name: string
  /** Monta a linha; com `base` (item existente) os campos omitidos são mantidos. */
  build: (base?: T) => T
}

function matchRows<T extends { id: string; weekday: number; name: string; sort: number }>(
  current: T[],
  incoming: Incoming<T>[],
  replace: boolean,
  what: PlanChange['what'],
  fields: (keyof T)[],
): { ops: Op[]; changes: PlanChange[] } {
  const used = new Set<string>()
  const ops: Op[] = []
  const changes: PlanChange[] = []
  const upsert = what === 'refeição' ? 'plan_meal.upsert' : 'plan_workout.upsert'
  const del = what === 'refeição' ? 'plan_meal.delete' : 'plan_workout.delete'

  for (const inc of incoming) {
    const cur = current.find(
      (c) => !used.has(c.id) && c.weekday === inc.weekday && normalizeText(c.name) === normalizeText(inc.name),
    )
    if (cur) {
      used.add(cur.id)
      const built = inc.build(cur)
      // Ordem só muda quando o plano é substituído inteiro.
      const next = { ...built, id: cur.id, sort: replace ? built.sort : cur.sort }
      const diffs = fieldChanges(cur, next, fields)
      if (diffs.length || sortChanged(cur, next) || cur.name !== next.name) {
        ops.push({ t: upsert, row: next } as unknown as Op)
        if (diffs.length || cur.name !== next.name) {
          changes.push({ kind: 'update', what, name: inc.name, weekdays: [inc.weekday], details: diffs.join(', ') || 'nome' })
        }
      }
    } else {
      const row = inc.build()
      ops.push({ t: upsert, row } as unknown as Op)
      const extra = 'kcal' in row && row.kcal != null ? `${row.kcal} kcal` : ''
      changes.push({ kind: 'add', what, name: row.name, weekdays: [row.weekday], details: extra })
    }
  }
  if (replace) {
    for (const c of current) {
      if (used.has(c.id)) continue
      ops.push({ t: del, id: c.id } as Op)
      changes.push({ kind: 'remove', what, name: c.name, weekdays: [c.weekday], details: '' })
    }
  }
  return { ops, changes }
}

/** Agrupa mudanças iguais em dias diferentes ("Almoço: kcal 518 → 600 · todos os dias"). */
function group(changes: PlanChange[]): PlanChange[] {
  const map = new Map<string, PlanChange>()
  for (const c of changes) {
    const k = `${c.kind}|${c.what}|${c.name}|${c.details}`
    const g = map.get(k)
    if (g) g.weekdays.push(...c.weekdays)
    else map.set(k, { ...c, weekdays: [...c.weekdays] })
  }
  return [...map.values()]
}

export function formatWeekdays(days: number[]): string {
  const set = [...new Set(days)].sort()
  if (set.length === 7) return 'todos os dias'
  const order = [1, 2, 3, 4, 5, 6, 0]
  return order.filter((d) => set.includes(d)).map((d) => WEEKDAY_SHORT[d]).join(', ')
}

export function diffPlan(data: AppData, plan: ImportPlan): PlanDiff {
  const meals: Incoming<PlanMeal>[] = plan.meals.flatMap((m, i) =>
    m.weekdays.map((wd) => ({ weekday: wd, name: m.name, build: (base?: PlanMeal) => buildPlanMeal(m, wd, i, base) })),
  )
  const workouts: Incoming<PlanWorkout>[] = plan.workouts.flatMap((w, i) =>
    w.weekdays.map((wd) => ({ weekday: wd, name: w.name, build: (base?: PlanWorkout) => buildPlanWorkout(w, wd, i, base) })),
  )
  const ops: Op[] = []
  const changes: PlanChange[] = []
  if (plan.meals.length) {
    const r = matchRows(data.plan_meals, meals, plan.replace, 'refeição', MEAL_FIELDS)
    ops.push(...r.ops)
    changes.push(...r.changes)
  }
  if (plan.workouts.length) {
    const r = matchRows(data.plan_workouts, workouts, plan.replace, 'treino', WORKOUT_FIELDS)
    ops.push(...r.ops)
    changes.push(...r.changes)
  }
  const settings: PlanDiff['settings'] = []
  if (plan.settings) {
    const patch: Partial<Settings> = {}
    for (const [k, v] of Object.entries(plan.settings) as [keyof Settings, never][]) {
      if (v === undefined || data.settings[k] === v) continue
      settings.push({ field: k, from: data.settings[k], to: v })
      ;(patch as Record<string, unknown>)[k] = v
    }
    if (Object.keys(patch).length) ops.push({ t: 'settings.update', row: patch })
  }

  const grouped = group(changes)
  const sign = { add: '+', update: '~', remove: '−' }
  const lines = grouped.map(
    (c) => `${sign[c.kind]} ${c.what} ${c.name}${c.details ? `: ${c.details}` : ''} · ${formatWeekdays(c.weekdays)}`,
  )
  const SET_LABEL: Record<string, string> = { calorie_goal: 'meta', tolerance_pct: 'tolerância %', base_expenditure: 'gasto base', timezone: 'fuso' }
  for (const s of settings) lines.push(`~ ${SET_LABEL[s.field]}: ${s.from ?? '–'} → ${s.to ?? '–'}`)
  return {
    ops: pruneNoops(ops, data),
    changes: grouped,
    settings,
    summary: lines.length ? lines.join('\n') : 'Nenhuma mudança: o plano já está assim.',
  }
}
