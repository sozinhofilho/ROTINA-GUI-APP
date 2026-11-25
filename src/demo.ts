// Modo demonstração: simula a API dentro do navegador com as MESMAS funções do servidor
// (applyOp, diffPlan, importDayToOps). Dados de exemplo; nada vai para o Supabase.
import seedPlan from '../supabase/seed-plan.json'
import { expandDay } from '../shared/calc.ts'
import { addDays, todayISO } from '../shared/dates.ts'
import { stableId } from '../shared/ids.ts'
import { applyOp, importDayToOps, importPlanToRows, PlanError } from '../shared/logic.ts'
import { diffPlan } from '../shared/plan.ts'
import { formatZodError, ImportDaySchema, ImportPlanSchema, MutateBodySchema, type Op } from '../shared/schemas.ts'
import type { AppData, DataResponse } from '../shared/types.ts'
import { DEFAULT_SETTINGS } from '../shared/types.ts'

const KEY = 'rotina:demo:v1'

function sampleData(): AppData {
  const { meals, workouts } = importPlanToRows(ImportPlanSchema.parse(seedPlan))
  // ids estáveis para o plano da demo
  const plan_meals = meals.map((m) => ({ ...m, id: stableId('demo-meal', m.weekday, m.name) }))
  const plan_workouts = workouts.map((w) => ({ ...w, id: stableId('demo-workout', w.weekday, w.name) }))
  let data: AppData = { settings: { ...DEFAULT_SETTINGS }, plan_meals, plan_workouts, overrides: [], meal_logs: [], workout_logs: [], extras: [] }
  const today = todayISO()
  // Últimos 8 dias de exemplo + café de hoje.
  const skips = [[], ['Lanche da tarde'], ['Ceia'], [], ['Ceia', 'Lanche da tarde'], [], ['Lanche da tarde'], []]
  for (let i = 8; i >= 1; i--) {
    const d = addDays(today, -i)
    const day = { date: d, meals: expandDay(d, data).meals.filter((m) => !skips[i - 1].includes(m.name)).map((m) => ({ name: m.name })), extras: [] as { description: string; kcal: number; time: string; category: 'alcool' | 'lanche' }[], workouts: [] as { name: string; duration_min: number }[] }
    if (i === 2) day.extras.push({ description: '3 latas de cerveja 350 ml', kcal: 450, time: '21:30', category: 'alcool' })
    if (i === 5) day.extras.push({ description: 'Pão de queijo', kcal: 220, time: '10:30', category: 'lanche' })
    if (i !== 3) day.workouts = expandDay(d, data).workouts.map((w) => ({ name: w.name, duration_min: w.plan?.duration_min ?? 60 }))
    const parsed = ImportDaySchema.parse(day)
    data = importDayToOps(parsed, data).reduce(applyOp, data)
  }
  const cafe = ImportDaySchema.parse({ date: today, meals: [{ name: 'Café da manhã' }] })
  return importDayToOps(cafe, data).reduce(applyOp, data)
}

function load(): AppData {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as AppData
  } catch {
    /* sem storage */
  }
  return sampleData()
}

let current: AppData | null = null
const getState = (): AppData => (current ??= load())

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(getState()))
  } catch {
    /* sem storage: segue em memória */
  }
}

export function resetDemo(): void {
  try {
    localStorage.removeItem(KEY)
    localStorage.removeItem('rotina:cache:v1')
    localStorage.removeItem('rotina:queue:v1')
  } catch {
    /* ignora */
  }
  location.reload()
}

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function handle(path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(path, location.href)
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
  let state = getState()
  await new Promise((r) => setTimeout(r, 120)) // latência de rede simulada
  switch (url.pathname.replace(/.*\/api\//, '/api/')) {
    case '/api/data': {
      const from = url.searchParams.get('from') ?? '0000'
      const to = url.searchParams.get('to') ?? '9999'
      const inR = (d: string) => d >= from && d <= to
      const resp: DataResponse = {
        ...state,
        overrides: state.overrides.filter((o) => inR(o.from_date) || inR(o.to_date)),
        meal_logs: state.meal_logs.filter((l) => inR(l.date)),
        workout_logs: state.workout_logs.filter((l) => inR(l.date)),
        extras: state.extras.filter((e) => inR(e.date)),
        photo_urls: {},
        features: { photo_ai: false, strava_configured: false, strava_connected: false },
      }
      return ok(resp)
    }
    case '/api/mutate': {
      const r = MutateBodySchema.safeParse(body)
      if (!r.success) return ok({ error: formatZodError(r.error) }, 400)
      state = current = r.data.ops.reduce((d: AppData, op: Op) => applyOp(d, op), state)
      save()
      return ok({ ok: true })
    }
    case '/api/import-plan': {
      const r = ImportPlanSchema.safeParse(body)
      if (!r.success) return ok({ error: formatZodError(r.error) }, 400)
      try {
        const diff = diffPlan(state, r.data)
        state = current = diff.ops.reduce(applyOp, state)
        save()
        return ok({ ok: true, operations: diff.ops.length, summary: diff.summary })
      } catch (e) {
        if (e instanceof PlanError) return ok({ error: e.message }, 400)
        throw e
      }
    }
    case '/api/import-day': {
      const r = ImportDaySchema.safeParse(body)
      if (!r.success) return ok({ error: formatZodError(r.error) }, 400)
      const ops = importDayToOps(r.data, state)
      state = current = ops.reduce(applyOp, state)
      save()
      return ok({ ok: true, applied: ops.length })
    }
    default:
      return ok({ error: 'não disponível na demonstração' }, 400)
  }
}

export function installDemo(): void {
  const realFetch = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (u.startsWith('/api/') || u.includes('/api/')) return handle(u, init)
    return realFetch(input, init)
  }
}
