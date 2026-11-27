// Modo demonstração: simula a API dentro do navegador com as MESMAS funções do servidor
// (applyOp, diffPlan, importDayToOps). Dados de exemplo; nada vai para o Supabase.
import seedPlan from '../supabase/seed-plan.json'
import { expandDay } from '../shared/calc.ts'
import { addDays, todayISO, weekdayOf } from '../shared/dates.ts'
import { stableId } from '../shared/ids.ts'
import { applyOp, importDayToOps, importPlanToRows, PlanError } from '../shared/logic.ts'
import { diffPlan } from '../shared/plan.ts'
import { formatZodError, ImportDaySchema, ImportPlanSchema, MutateBodySchema, type Op } from '../shared/schemas.ts'
import type { AppData, DataResponse } from '../shared/types.ts'
import { DEFAULT_SETTINGS } from '../shared/types.ts'

const KEY = 'rotina:demo:v3'

function sampleData(): AppData {
  const { meals, workouts } = importPlanToRows(ImportPlanSchema.parse(seedPlan))
  // ids estáveis para o plano da demo
  const plan_meals = meals.map((m) => ({ ...m, id: stableId('demo-meal', m.weekday, m.name) }))
  const plan_workouts = workouts.map((w) => ({ ...w, id: stableId('demo-workout', w.weekday, w.name) }))
  let data: AppData = { settings: { ...DEFAULT_SETTINGS, base_expenditure: 2300 }, plan_meals, plan_workouts, overrides: [], meal_logs: [], workout_logs: [], extras: [], water: [], body: [] }
  const today = todayISO()
  // 5 semanas de exemplo, com padrão realista: fins de semana mais soltos.
  const rnd = (i: number) => ((i * 9301 + 49297) % 233280) / 233280
  let weight = 86.4
  for (let i = 35; i >= 1; i--) {
    const d = addDays(today, -i)
    const wd = weekdayOf(d)
    const weekend = wd === 0 || wd === 6
    const r = rnd(i)
    const skip: string[] = []
    if (r < 0.25) skip.push('Lanche da tarde')
    if (weekend && r > 0.5) skip.push('Ceia')
    const extras: { description: string; kcal: number; time: string; category: 'alcool' | 'lanche' }[] = []
    if (weekend && r > 0.35) extras.push({ description: `${2 + Math.round(r * 3)} latas de cerveja 350 ml`, kcal: 150 * (2 + Math.round(r * 3)), time: '20:30', category: 'alcool' })
    if (!weekend && r > 0.85) extras.push({ description: 'Pão de queijo', kcal: 220, time: '10:30', category: 'lanche' })
    const day = {
      date: d,
      meals: expandDay(d, data).meals.filter((m) => !skip.includes(m.name)).map((m) => ({ name: m.name })),
      extras,
      workouts: r > 0.18 || weekend ? expandDay(d, data).workouts.map((w) => ({ name: w.name, duration_min: w.plan?.duration_min ?? 60, kcal: r > 0.5 && w.plan?.kcal ? Math.round(w.plan.kcal * (0.9 + r * 0.3)) : null })) : [],
    }
    data = importDayToOps(ImportDaySchema.parse(day), data).reduce(applyOp, data)
    data = applyOp(data, { t: 'water.set', row: { date: d, ml: weekend ? 3000 + Math.round(r * 4) * 500 : 4000 + Math.round(r * 3) * 500 } })
    // Peso na segunda (sobe depois do fim de semana) e na sexta (cai durante a semana).
    if (wd === 1) weight += 0.5 + r * 0.4
    if (wd === 5) weight -= 0.9 + r * 0.3
    if (wd === 1 || wd === 5) {
      const kg = Math.round(weight * 10) / 10
      data = applyOp(data, {
        t: 'body.upsert',
        row: { id: stableId('body', d), date: d, weight_kg: kg, photo_front: `${d.slice(0, 7)}/exemplo-frente-${d}.svg`, photo_side: `${d.slice(0, 7)}/exemplo-lado-${d}.svg`, note: '' },
      })
    }
  }
  data = applyOp(data, { t: 'water.set', row: { date: today, ml: 1500 } })
  const cafe = ImportDaySchema.parse({ date: today, meals: [{ name: 'Café da manhã' }] })
  return importDayToOps(cafe, data).reduce(applyOp, data)
}

/** Silhueta de exemplo (as fotos reais ficam no Supabase; na demo é só ilustração). */
function sampleSilhouette(path: string, data: AppData): string {
  const m = /exemplo-(frente|lado)-(\d{4}-\d{2}-\d{2})/.exec(path)
  const side = m?.[1] === 'lado'
  const kg = (data.body ?? []).find((b) => b.date === m?.[2])?.weight_kg ?? 85
  const w = side ? 30 + (kg - 80) * 1.6 : 52 + (kg - 80) * 2.2
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 200"><rect width="150" height="200" fill="#26323d"/><circle cx="75" cy="34" r="15" fill="#8aa0b2"/><rect x="${75 - w / 2}" y="52" width="${w}" height="80" rx="${w / 3}" fill="#8aa0b2"/><rect x="${75 - w / 2 + 4}" y="128" width="${w / 2 - 6}" height="62" rx="6" fill="#8aa0b2"/><rect x="${75 + 2}" y="128" width="${w / 2 - 6}" height="62" rx="6" fill="#8aa0b2"/><text x="75" y="196" font-size="9" fill="#cfd8df" text-anchor="middle" font-family="sans-serif">exemplo · ${side ? 'lado' : 'frente'}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

// Fotos enviadas na demo ficam só na memória (somem ao recarregar).
const uploaded = new Map<string, string>()

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
        water: (state.water ?? []).filter((w) => inR(w.date)),
        body: (state.body ?? []).filter((b) => inR(b.date)),
        first_date: [...state.meal_logs, ...(state.body ?? [])].map((x) => x.date).sort()[0] ?? null,
        photo_urls: Object.fromEntries(
          (state.body ?? []).flatMap((b) => [b.photo_front, b.photo_side]).filter((p): p is string => !!p)
            .map((p) => [p, uploaded.get(p) ?? sampleSilhouette(p, state)]),
        ),
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
    case '/api/photo': {
      const date = url.searchParams.get('date') ?? todayISO()
      const blob = init.body instanceof Blob ? init.body : null
      if (!blob) return ok({ error: 'imagem vazia' }, 400)
      const dataUrl = await new Promise<string>((resolve) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result))
        fr.readAsDataURL(blob)
      })
      const path = `${date.slice(0, 7)}/${date}-${crypto.randomUUID()}.jpg`
      uploaded.set(path, dataUrl)
      return ok({ path, url: dataUrl })
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
