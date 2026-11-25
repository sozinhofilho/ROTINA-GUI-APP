// Testes do conector MCP de ponta a ponta: cliente oficial do SDK -> Streamable HTTP -> handler real,
// com o banco trocado por um Store em memória de mesma semântica (applyOp).
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { expandDay, summarize } from '../shared/calc.ts'
import { applyOp, importPlanToRows } from '../shared/logic.ts'
import { ImportPlanSchema } from '../shared/schemas.ts'
import type { AppData } from '../shared/types.ts'
import { DEFAULT_SETTINGS } from '../shared/types.ts'
import { makeExportUrl, verifyExportUrl } from '../netlify/lib/export-link.ts'
import { createMcpHandler } from '../netlify/lib/mcp.ts'
import { memoryStore } from '../netlify/lib/store.ts'

process.env.MCP_TOKEN = 'mcp-token-de-teste-1234567890'
const TOKEN = process.env.MCP_TOKEN
const NOW = new Date('2026-11-25T15:00:00Z') // quarta, 12h em São Paulo
const WED = '2026-11-25'
const FRI = '2026-11-27'
const SAT = '2026-11-28'

const seedPlan = JSON.parse(readFileSync('supabase/seed-plan.json', 'utf8'))

function seed(): AppData {
  const { meals, workouts } = importPlanToRows(ImportPlanSchema.parse(seedPlan))
  return { settings: { ...DEFAULT_SETTINGS }, plan_meals: meals, plan_workouts: workouts, overrides: [], meal_logs: [], workout_logs: [], extras: [] }
}

let store: ReturnType<typeof memoryStore>
let pathTokenAllowed = false
let handler: (req: Request) => Promise<Response>

beforeEach(() => {
  store = memoryStore(seed())
  pathTokenAllowed = false
  handler = createMcpHandler({
    store,
    token: () => process.env.MCP_TOKEN,
    allowPathToken: () => pathTokenAllowed,
    baseUrl: () => 'https://rotina.example',
    exportUrl: makeExportUrl,
    now: () => NOW,
  })
})

async function client(token = TOKEN): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('https://rotina.example/mcp'), {
    fetch: (url, init) => handler(new Request(url, init)),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const c = new Client({ name: 'teste', version: '1.0.0' })
  await c.connect(transport)
  return c
}

type Result = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> }

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await c.callTool({ name, arguments: args })) as Result
}

/** Erro de validação: o SDK pode devolver isError ou lançar -32602; aceitamos os dois. */
async function expectInvalid(c: Client, name: string, args: Record<string, unknown>, pattern?: RegExp) {
  let text = ''
  try {
    const r = await call(c, name, args)
    expect(r.isError).toBe(true)
    text = r.content[0].text
  } catch (e) {
    text = (e as Error).message
  }
  if (pattern) expect(text).toMatch(pattern)
}

const rpc = (body: unknown, headers: Record<string, string> = {}, path = '/mcp', method = 'POST') =>
  handler(
    new Request(`https://rotina.example${path}`, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    }),
  )
const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }

describe('autenticação', () => {
  it('sem token: 401 sem detalhes', async () => {
    const r = await rpc(LIST)
    expect(r.status).toBe(401)
    expect(await r.json()).toEqual({ error: 'unauthorized' })
    expect(r.headers.get('www-authenticate')).toMatch(/^Bearer/)
  })
  it('token errado: 401 (também em cada ferramenta)', async () => {
    expect((await rpc(LIST, { authorization: 'Bearer errado' })).status).toBe(401)
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_day', arguments: { date: WED } } }
    for (const auth of ['', 'Bearer ', `Basic ${TOKEN}`, `Bearer ${TOKEN}x`, TOKEN]) {
      expect((await rpc(call, auth ? { authorization: auth } : {})).status).toBe(401)
    }
    await expect(client('token-errado')).rejects.toThrow()
  })
  it('token certo: lista as 11 ferramentas', async () => {
    const c = await client()
    const names = (await c.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual(['add_extra', 'get_day', 'get_export', 'get_plan', 'get_range', 'import_json', 'log_workout', 'move_workout', 'remove_entry', 'set_meal_done', 'update_plan'])
  })
  it('GET (stream SSE) não é suportado em modo stateless: 405', async () => {
    expect((await rpc(null, { authorization: `Bearer ${TOKEN}` }, '/mcp', 'GET')).status).toBe(405)
  })
  it('token no caminho só funciona se MCP_ALLOW_PATH_TOKEN estiver ligado', async () => {
    expect((await rpc(LIST, {}, `/mcp/${TOKEN}`)).status).toBe(401)
    pathTokenAllowed = true
    expect((await rpc(LIST, {}, `/mcp/${TOKEN}`)).status).toBe(200)
    expect((await rpc(LIST, {}, '/mcp/outro')).status).toBe(401)
  })
  it('sem MCP_TOKEN configurado: 503', async () => {
    const old = process.env.MCP_TOKEN
    delete process.env.MCP_TOKEN
    try {
      expect((await rpc(LIST, { authorization: 'Bearer x' })).status).toBe(503)
    } finally {
      process.env.MCP_TOKEN = old
    }
  })
})

describe('get_day', () => {
  it('mesmos números que o app (expandDay)', async () => {
    const c = await client()
    await call(c, 'set_meal_done', { date: WED, meal_id: 'café da manhã', done: true })
    await call(c, 'add_extra', { date: WED, description: '2 cervejas', kcal: 300 })
    const r = await call(c, 'get_day', { date: WED })
    const app = expandDay(WED, store.data).stats
    const totals = (r.structuredContent as { totals: Record<string, unknown> }).totals
    expect(totals).toMatchObject({ kcal_in: app.kcalIn, goal_min: app.min, goal_max: app.max, status: app.status, in_goal: app.inGoal, kcal_spent: app.spent, balance: app.balance })
    expect(totals.kcal_in).toBe(682 + 300)
    expect(r.content[0].text).toContain('982 de 2.500 kcal')
  })
  it('sem data usa hoje (São Paulo)', async () => {
    const r = await call(await client(), 'get_day')
    expect((r.structuredContent as { date: string }).date).toBe(WED)
  })
  it('valida a data', async () => {
    await expectInvalid(await client(), 'get_day', { date: '25/11/2026' }, /AAAA-MM-DD/)
  })
})

describe('get_range', () => {
  it('métricas iguais ao Resumo do app (summarize)', async () => {
    const c = await client()
    for (const d of ['2026-11-23', '2026-11-24']) {
      await call(c, 'import_json', { payload: { date: d, meals: ['Café da manhã', 'Almoço', 'Lanche da tarde', 'Jantar', 'Ceia'].map((name) => ({ name })) }, confirm: true })
    }
    const r = await call(c, 'get_range', { from: '2026-11-23', to: '2026-11-29' })
    const m = (r.structuredContent as { metrics: Record<string, number> }).metrics
    const app = summarize('2026-11-23', '2026-11-29', store.data, WED)
    expect(m).toMatchObject({ days_counted: app.days, days_in_goal: app.daysInGoal, avg_kcal_in: app.avgKcalIn, meals_adherence_pct: app.pctMeals, best_streak_in_goal: 2 })
    expect(m.days_in_goal).toBe(2)
  })
  it('valida intervalo', async () => {
    const c = await client()
    await expectInvalid(c, 'get_range', { from: '2026-11-30', to: '2026-11-01' }, /anterior/)
    await expectInvalid(c, 'get_range', { from: '2026-11-01' })
  })
})

describe('get_plan', () => {
  it('devolve a semana com ids', async () => {
    const r = await call(await client(), 'get_plan')
    const week = (r.structuredContent as { week: { day: string; kcal_total: number; workouts: { name: string }[] }[] }).week
    expect(week).toHaveLength(7)
    expect(week[0]).toMatchObject({ day: 'Seg', kcal_total: 2501 })
    expect(week[1].workouts.map((w) => w.name)).toEqual(['Upper A', 'Corrida leve 6 km'])
  })
})

describe('set_meal_done', () => {
  it('marca pelo nome, aceita kcal real e é idempotente', async () => {
    const c = await client()
    const r1 = await call(c, 'set_meal_done', { date: WED, meal_id: 'almoco', done: true, kcal_real: 650 })
    expect(r1.isError).toBeFalsy()
    expect(r1.structuredContent).toMatchObject({ changed: true })
    const writes = store.writes
    const r2 = await call(c, 'set_meal_done', { date: WED, meal_id: 'almoco', done: true, kcal_real: 650 })
    expect(r2.structuredContent).toMatchObject({ changed: false })
    expect(store.writes).toBe(writes)
    expect(store.data.meal_logs).toHaveLength(1)
    expect(expandDay(WED, store.data).stats.kcalIn).toBe(650)
    await call(c, 'set_meal_done', { date: WED, meal_id: 'almoco', done: false })
    expect(expandDay(WED, store.data).stats.kcalIn).toBe(0)
  })
  it('erro claro quando a refeição não existe', async () => {
    const r = await call(await client(), 'set_meal_done', { date: WED, meal_id: 'brunch', done: true })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/refeição não encontrada nesse dia/i)
  })
  it('valida entradas', async () => {
    await expectInvalid(await client(), 'set_meal_done', { date: WED, meal_id: 'almoço', kcal_real: -5 })
  })
})

describe('log_workout', () => {
  it('cumpre o treino previsto do mesmo tipo, sem duplicar', async () => {
    const c = await client()
    const args = { date: WED, type: 'hyrox', duration_min: 62, kcal: 740, avg_hr: 151 }
    const r = await call(c, 'log_workout', args)
    expect(r.structuredContent).toMatchObject({ changed: true })
    await call(c, 'log_workout', args)
    expect(store.data.workout_logs).toHaveLength(1)
    const day = expandDay(WED, store.data)
    expect(day.workouts[0].log).toMatchObject({ done: true, kcal: 740, duration_min: 62 })
    expect(day.stats.kcalWorkouts).toBe(740)
  })
  it('corrida com distância e pace; sem previsto vira avulso', async () => {
    const c = await client()
    await call(c, 'log_workout', { date: '2026-11-24', type: 'run', duration_min: 33, distance_km: 6, avg_pace: '5:30' })
    expect(expandDay('2026-11-24', store.data).workouts.find((w) => w.plan?.name === 'Corrida leve 6 km')?.log).toMatchObject({ distance_m: 6000, avg_pace: '5:30', kcal: 450 })
    const r = await call(c, 'log_workout', { date: WED, type: 'run', duration_min: 20 })
    expect(r.content[0].text).toMatch(/avulso/)
    await call(c, 'log_workout', { date: WED, type: 'run', duration_min: 20 })
    expect(store.data.workout_logs.filter((l) => l.date === WED)).toHaveLength(1)
  })
  it('erro claro com workout_id inexistente e validação', async () => {
    const c = await client()
    const r = await call(c, 'log_workout', { date: WED, workout_id: 'natação', type: 'other', duration_min: 30 })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/treino não encontrado nesse dia/i)
    await expectInvalid(c, 'log_workout', { date: WED, type: 'run', duration_min: 30, avg_pace: '5min' }, /pace/)
    await expectInvalid(c, 'log_workout', { date: WED, type: 'yoga', duration_min: 30 })
  })
})

describe('add_extra', () => {
  it('detecta álcool e não duplica', async () => {
    const c = await client()
    const args = { date: WED, description: '2 latas de cerveja 350 ml', kcal: 300, time: '21:00' }
    await call(c, 'add_extra', args)
    const r = await call(c, 'add_extra', args)
    expect(r.structuredContent).toMatchObject({ changed: false })
    expect(store.data.extras).toHaveLength(1)
    expect(store.data.extras[0].category).toBe('alcool')
    await call(c, 'add_extra', { ...args, time: '23:00' })
    expect(store.data.extras).toHaveLength(2)
  })
  it('valida entradas', async () => {
    const c = await client()
    await expectInvalid(c, 'add_extra', { date: WED, description: 'bolo' })
    await expectInvalid(c, 'add_extra', { date: WED, description: 'bolo', kcal: 300, time: '25:00' }, /HH:MM/)
  })
})

describe('remove_entry', () => {
  it('desfaz extra, refeição, treino e troca; repetir não falha', async () => {
    const c = await client()
    const ex = await call(c, 'add_extra', { date: WED, description: 'pão de queijo', kcal: 200 })
    const id = (ex.structuredContent as { extra_id: string }).extra_id
    expect((await call(c, 'remove_entry', { date: WED, entry_type: 'extra', entry_id: id })).structuredContent).toMatchObject({ changed: true })
    const again = await call(c, 'remove_entry', { date: WED, entry_type: 'extra', entry_id: id })
    expect(again.isError).toBeFalsy()
    expect(again.content[0].text).toMatch(/nada a desfazer/i)
    await call(c, 'set_meal_done', { date: WED, meal_id: 'jantar', done: true })
    await call(c, 'remove_entry', { date: WED, entry_type: 'meal', entry_id: 'jantar' })
    expect(store.data.meal_logs).toHaveLength(0)
    await call(c, 'log_workout', { date: WED, type: 'hyrox', duration_min: 60 })
    await call(c, 'remove_entry', { date: WED, entry_type: 'workout', entry_id: 'HYROX' })
    expect(store.data.workout_logs).toHaveLength(0)
    await call(c, 'move_workout', { from_date: FRI, to_date: SAT })
    await call(c, 'remove_entry', { date: FRI, entry_type: 'move', entry_id: store.data.overrides[0].id })
    expect(store.data.overrides).toHaveLength(0)
  })
  it('erro claro e validação', async () => {
    const c = await client()
    const r = await call(c, 'remove_entry', { date: WED, entry_type: 'meal', entry_id: 'brunch' })
    expect(r.isError).toBe(true)
    await expectInvalid(c, 'remove_entry', { date: WED, entry_type: 'foto', entry_id: 'x' })
  })
})

describe('move_workout', () => {
  it('troca sexta por sábado só naquela semana, idempotente', async () => {
    const c = await client()
    const r = await call(c, 'move_workout', { from_date: FRI, to_date: SAT })
    expect(r.content[0].text).toMatch(/HYROX de Sex, 27 nov para Sáb, 28 nov/)
    await call(c, 'move_workout', { from_date: FRI, to_date: SAT })
    expect(store.data.overrides).toHaveLength(1)
    expect(expandDay(FRI, store.data).workouts).toHaveLength(0)
    const sat = await call(c, 'get_day', { date: SAT })
    const ws = (sat.structuredContent as { workouts: { name: string; moved_from: string | null }[] }).workouts
    expect(ws.map((w) => [w.name, w.moved_from])).toEqual([['Lower B', null], ['HYROX', FRI]])
    expect(expandDay('2026-12-04', store.data).workouts.map((w) => w.name)).toEqual(['HYROX'])
    // mover de novo a partir do sábado ajusta a troca original (de sexta)
    await call(c, 'move_workout', { from_date: SAT, to_date: '2026-11-29', workout_id: 'HYROX' })
    expect(store.data.overrides).toEqual([expect.objectContaining({ from_date: FRI, to_date: '2026-11-29' })])
  })
  it('erros e validação', async () => {
    const c = await client()
    expect((await call(c, 'move_workout', { from_date: FRI, to_date: FRI })).isError).toBe(true)
    expect((await call(c, 'move_workout', { from_date: FRI, to_date: SAT, workout_id: 'yoga' })).isError).toBe(true)
    await expectInvalid(c, 'move_workout', { from_date: 'sexta', to_date: SAT })
  })
})

describe('update_plan', () => {
  const change = { replace: false, meals: [{ weekdays: 'todos', name: 'Almoço', time: '12:30', kcal: 600, protein: 45, carbs: 70, fat: 10 }] }
  it('prévia não grava; confirm grava; repetir não muda; ids preservados', async () => {
    const c = await client()
    const lunchIds = store.data.plan_meals.filter((m) => m.name === 'Almoço').map((m) => m.id).sort()
    const p = await call(c, 'update_plan', { plan_json: change })
    expect(p.content[0].text).toMatch(/Prévia[\s\S]*Almoço: horário 12:00 → 12:30, kcal 518 → 600[\s\S]*todos os dias/)
    expect(store.writes).toBe(0)
    const ok = await call(c, 'update_plan', { plan_json: JSON.stringify(change), confirm: true })
    expect(ok.structuredContent).toMatchObject({ confirmed: true })
    expect(store.data.plan_meals.filter((m) => m.name === 'Almoço').map((m) => m.id).sort()).toEqual(lunchIds)
    expect(expandDay(WED, store.data).stats.kcalPlanned).toBe(2501 - 518 + 600)
    const writes = store.writes
    const again = await call(c, 'update_plan', { plan_json: change, confirm: true })
    expect(again.content[0].text).toMatch(/Nenhuma mudança/)
    expect(store.writes).toBe(writes)
  })
  it('reaplicar o plano completo do seed não muda nada', async () => {
    const r = await call(await client(), 'update_plan', { plan_json: seedPlan, confirm: true })
    expect(r.content[0].text).toMatch(/Nenhuma mudança/)
    expect(store.writes).toBe(0)
  })
  it('valida', async () => {
    const c = await client()
    const r = await call(c, 'update_plan', { plan_json: { meals: [{ name: 'X', time: '99:00', kcal: 1 }] } })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/horário deve ser HH:MM/)
    expect((await call(c, 'update_plan', { plan_json: '{quebrado' })).content[0].text).toMatch(/JSON válido/)
  })
})

describe('import_json', () => {
  const day = {
    date: WED,
    meals: [{ name: 'Almoço', kcal: 650 }],
    extras: [{ description: '2 cervejas', kcal: 300, time: '21:00', category: 'alcool' }],
    workouts: [{ name: 'HYROX', duration_min: 62, kcal: 740 }],
  }
  it('prévia, confirmação e merge idempotente', async () => {
    const c = await client()
    const p = await call(c, 'import_json', { payload: day })
    expect(p.content[0].text).toMatch(/Prévia \(3 alteração/)
    expect(store.writes).toBe(0)
    await call(c, 'import_json', { payload: day, confirm: true })
    const again = await call(c, 'import_json', { payload: JSON.stringify(day), confirm: true })
    expect(again.content[0].text).toMatch(/Nenhuma mudança/)
    expect(store.data.extras).toHaveLength(1)
    expect(store.data.meal_logs).toHaveLength(1)
    expect(store.data.workout_logs).toHaveLength(1)
    expect(expandDay(WED, store.data).stats).toMatchObject({ kcalIn: 950, kcalWorkouts: 740 })
  })
  it('aceita lista de dias e plano', async () => {
    const c = await client()
    const r = await call(c, 'import_json', { payload: [day, { ...day, date: '2026-11-24' }], confirm: true })
    expect(r.structuredContent).toMatchObject({ operations: 6 })
    const plan = await call(c, 'import_json', { payload: { replace: false, settings: { calorie_goal: 2600 } } })
    expect(plan.content[0].text).toMatch(/meta: 2500 → 2600/)
  })
  it('valida', async () => {
    const r = await call(await client(), 'import_json', { payload: { date: '2026-02-30', meals: [] } })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/AAAA-MM-DD/)
  })
})

describe('get_export', () => {
  it('link assinado e temporário, sem token na URL', async () => {
    const r = await call(await client(), 'get_export', { from: '2026-11-01', to: WED, format: 'csv' })
    const { url } = r.structuredContent as { url: string }
    expect(url).toMatch(/^https:\/\/rotina\.example\/api\/export-file\?from=2026-11-01&to=2026-11-25&format=csv&exp=\d+&sig=/)
    expect(url).not.toContain(TOKEN)
    const q = new URL(url).searchParams
    expect(verifyExportUrl(q, NOW)).toBe(true)
    expect(verifyExportUrl(q, new Date(NOW.getTime() + 2 * 3600_000))).toBe(false)
    q.set('to', '2026-12-31')
    expect(verifyExportUrl(q, NOW)).toBe(false)
  })
  it('valida', async () => {
    const c = await client()
    await expectInvalid(c, 'get_export', { from: WED, to: WED, format: 'pdf' })
    expect((await call(c, 'get_export', { from: WED, to: '2026-11-01' })).isError).toBe(true)
  })
})

describe('app e MCP chegam aos mesmos números', () => {
  it('a mesma ação pelo app (fila de operações) e pelo MCP produz o mesmo dia', async () => {
    // App: o check gera um meal_log.upsert aplicado com applyOp (igual à tela Hoje).
    let appData = seed()
    const lunch = expandDay(WED, appData).meals.find((m) => m.name === 'Almoço')!
    appData = applyOp(appData, {
      t: 'meal_log.upsert',
      row: { id: crypto.randomUUID(), date: WED, plan_meal_id: lunch.plan!.id, meal_name: 'Almoço', done: true, kcal_planned: 518, kcal_real: 650, note: '', photo_path: null, ai_estimate: null },
    })
    appData = applyOp(appData, { t: 'extra.upsert', row: { id: crypto.randomUUID(), date: WED, time: null, description: 'cerveja', kcal: 150, category: 'alcool' } })
    appData = applyOp(appData, { t: 'settings.update', row: { base_expenditure: 2200 } })
    // MCP: mesmas ações por conversa.
    store.data = { ...store.data, plan_meals: appData.plan_meals, plan_workouts: appData.plan_workouts }
    const c = await client()
    await call(c, 'set_meal_done', { date: WED, meal_id: 'almoço', done: true, kcal_real: 650 })
    await call(c, 'add_extra', { date: WED, description: 'cerveja', kcal: 150 })
    await call(c, 'update_plan', { plan_json: { replace: false, settings: { base_expenditure: 2200 } }, confirm: true })
    const viaMcp = (await call(c, 'get_day', { date: WED })).structuredContent as { totals: Record<string, unknown> }
    const viaApp = expandDay(WED, appData).stats
    expect(viaMcp.totals).toMatchObject({ kcal_in: viaApp.kcalIn, kcal_spent: viaApp.spent, balance: viaApp.balance, status: viaApp.status, in_goal: viaApp.inGoal })
    expect(viaApp).toMatchObject({ kcalIn: 800, spent: 2200, balance: -1400, status: 'abaixo' })
  })
})

describe('arquivo de exportação (mesma planilha do app)', () => {
  it('gera xlsx com 5 abas e csv', async () => {
    const XLSX = await import('xlsx')
    const { buildCsv, buildExportSheets, buildWorkbook } = await import('../shared/export.ts')
    const c = await client()
    await call(c, 'add_extra', { date: WED, description: '2 cervejas', kcal: 300 })
    const sheets = buildExportSheets(store.data, '2026-11-23', WED, WED)
    const buf = XLSX.write(buildWorkbook(XLSX, sheets) as never, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    expect(XLSX.read(buf).SheetNames).toEqual(['Resumo diário', 'Refeições', 'Treinos', 'Extras', 'Resumo semanal'])
    const csv = buildCsv(XLSX, sheets)
    expect(csv).toContain('# Extras')
    expect(csv).toContain('2 cervejas;Outro;300'.replace('Outro', 'Álcool'))
  })
})

describe('update_plan parcial', () => {
  it('mudar só o horário mantém macros e alimentos; item novo exige time e kcal', async () => {
    const c = await client()
    const before = store.data.plan_meals.find((m) => m.name === 'Ceia' && m.weekday === 3)!
    const p = await call(c, 'update_plan', { plan_json: { replace: false, meals: [{ weekdays: 'qua', name: 'Ceia', time: '22:00' }] }, confirm: true })
    expect(p.content[0].text).toMatch(/Ceia: horário 21:30 → 22:00 · Qua$/m)
    const after = store.data.plan_meals.find((m) => m.id === before.id)!
    expect(after).toEqual({ ...before, time: '22:00' })
    const bad = await call(c, 'update_plan', { plan_json: { replace: false, meals: [{ name: 'Brunch' }] } })
    expect(bad.isError).toBe(true)
    expect(bad.content[0].text).toMatch(/informe time e kcal/)
  })
})
