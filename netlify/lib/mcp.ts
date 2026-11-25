// Servidor MCP (Streamable HTTP, sem sessão) para conversar com o Claude e atualizar a Rotina.
// Autenticação: Authorization: Bearer <MCP_TOKEN>, comparado em tempo constante.
// Nunca registra token nem dados de saúde em log.
import { createHash, timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { formatDayLabel, isISODate, todayISO } from '../../shared/dates.ts'
import { pace } from '../../shared/schemas.ts'
import type { Store } from './store.ts'
import * as tools from './tools.ts'
import { ToolError, type ToolContext, type ToolResult } from './tools.ts'

export interface McpOptions {
  store: Store
  /** MCP_TOKEN esperado (lido a cada requisição). */
  token: () => string | undefined
  /** Origem pública do site, para os links de exportação. */
  baseUrl: (req: Request) => string
  exportUrl: (baseUrl: string, from: string, to: string, format: 'xlsx' | 'csv', now: Date) => { url: string; expires_at: string }
  /** Plano B opcional: aceitar o token no caminho (/mcp/<token>) quando o cliente não envia headers. */
  allowPathToken?: () => boolean
  now?: () => Date
}

const date = z.string().refine(isISODate, 'use o formato AAAA-MM-DD').describe('Data AAAA-MM-DD (fuso America/Sao_Paulo)')
const optDate = date.optional().describe('Data AAAA-MM-DD (fuso America/Sao_Paulo). Se omitida, usa hoje.')
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'horário deve ser HH:MM')
const kind = z.enum(['hyrox', 'run', 'strength', 'other'])

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })
}

const digest = (s: string) => createHash('sha256').update(s).digest()

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b))
}

/** Loga só o tipo do erro: mensagens do banco podem conter dados de saúde. */
function logError(where: string, err: unknown): void {
  const name = err instanceof Error ? err.constructor.name : typeof err
  console.error(`[mcp] erro em ${where}: ${name}`)
}

function wrap<A>(name: string, ctx: ToolContext, fn: (ctx: ToolContext, a: A) => Promise<ToolResult>) {
  return async (args: A) => {
    try {
      const r = await fn(ctx, args)
      return {
        content: [
          { type: 'text' as const, text: r.text },
          { type: 'text' as const, text: JSON.stringify(r.data) },
        ],
        structuredContent: r.data,
      }
    } catch (err) {
      if (err instanceof ToolError) return { isError: true, content: [{ type: 'text' as const, text: err.message }] }
      logError(name, err)
      return { isError: true, content: [{ type: 'text' as const, text: 'Erro interno ao acessar os dados da Rotina. Tente de novo em instantes.' }] }
    }
  }
}

export function buildServer(ctx: ToolContext): McpServer {
  const t = todayISO('America/Sao_Paulo', ctx.now())
  const server = new McpServer(
    { name: 'rotina', version: '1.0.0' },
    {
      instructions: [
        `Rotina: diário pessoal de dieta e treino do Guilherme. Hoje é ${formatDayLabel(t)} (${t}), fuso America/Sao_Paulo.`,
        'Datas sempre AAAA-MM-DD. Para marcar refeição ou treino, chame get_day antes se não souber o meal_id/workout_id (nomes como "almoço" também funcionam).',
        'Calorias: estime de forma conservadora quando o usuário não disser (ex.: cerveja lata 350 ml ≈ 150 kcal) e diga que é estimativa.',
        'update_plan e import_json: chame primeiro sem confirm para mostrar a prévia; só use confirm=true depois que o usuário aprovar.',
        'Responda curto, em português do Brasil.',
      ].join('\n'),
    },
  )
  const ro = { readOnlyHint: true, openWorldHint: false }
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }

  server.registerTool('get_day', {
    title: 'Ver dia',
    description: 'Mostra o plano do dia (refeições e treinos), o que foi feito, extras, kcal consumidas, kcal gastas, saldo e se está dentro da meta.',
    inputSchema: { date: optDate },
    annotations: ro,
  }, wrap('get_day', ctx, tools.getDay))

  server.registerTool('get_range', {
    title: 'Ver período',
    description: 'Registros por dia e métricas do período: adesão a refeições e treinos, médias de kcal ingeridas e gastas, dias dentro da meta e sequência atual. Dias futuros não contam.',
    inputSchema: { from: date, to: date },
    annotations: ro,
  }, wrap('get_range', ctx, tools.getRange))

  server.registerTool('get_plan', {
    title: 'Ver plano semanal',
    description: 'Plano semanal vigente: refeições (horário, alimentos, kcal, macros) e treinos de cada dia, com seus ids, mais meta e tolerância.',
    inputSchema: {},
    annotations: ro,
  }, wrap('get_plan', ctx, (c) => tools.getPlan(c)))

  server.registerTool('set_meal_done', {
    title: 'Marcar refeição',
    description: 'Marca ou desmarca uma refeição do dia como feita. Opcional: calorias reais e observação. Repetir a chamada não duplica.',
    inputSchema: {
      date: optDate,
      meal_id: z.string().min(1).describe('meal_id do plano (get_day/get_plan) ou o nome da refeição, ex.: "almoço"'),
      done: z.boolean().default(true).describe('true = feita, false = desmarcar'),
      kcal_real: z.number().int().min(0).max(20000).nullable().optional().describe('Calorias reais (null limpa e volta ao previsto)'),
      note: z.string().max(4000).optional().describe('Observação'),
    },
    annotations: write,
  }, wrap('set_meal_done', ctx, tools.setMealDone))

  server.registerTool('log_workout', {
    title: 'Registrar treino',
    description: 'Registra um treino concluído. Sem workout_id, usa o treino previsto do dia com o mesmo tipo; se não houver, cria um treino avulso. Repetir a chamada atualiza o mesmo registro.',
    inputSchema: {
      date: optDate,
      workout_id: z.string().min(1).optional().describe('workout_id do plano (get_day) ou nome do treino, ex.: "HYROX"'),
      type: kind.describe('hyrox, run (corrida), strength (musculação) ou other'),
      duration_min: z.number().int().min(1).max(1440).describe('Duração em minutos'),
      distance_km: z.number().min(0).max(1000).optional().describe('Distância em km'),
      avg_pace: pace.optional().describe('Pace médio mm:ss por km, ex.: "5:30"'),
      avg_hr: z.number().min(30).max(260).optional().describe('Frequência cardíaca média (bpm)'),
      kcal: z.number().int().min(0).max(20000).optional().describe('Calorias gastas; se omitido usa a estimativa do plano'),
      source: z.enum(['manual', 'strava', 'import']).optional().describe('Origem do dado (padrão manual)'),
      note: z.string().max(4000).optional().describe('Observação'),
    },
    annotations: write,
  }, wrap('log_workout', ctx, tools.logWorkout))

  server.registerTool('add_extra', {
    title: 'Lançar extra',
    description: 'Lança algo fora do plano (álcool, lanche, refeição fora) com descrição e kcal. A mesma combinação de data, descrição, kcal e horário não é duplicada; para lançar outro item igual, informe outro horário.',
    inputSchema: {
      date: optDate,
      description: z.string().min(1).max(300).describe('Ex.: "2 latas de cerveja 350 ml"'),
      kcal: z.number().int().min(0).max(20000).describe('Calorias totais do lançamento'),
      time: hhmm.optional().describe('Horário HH:MM'),
      category: z.enum(['alcool', 'lanche', 'refeicao', 'outro']).optional().describe('Se omitido, álcool é detectado pela descrição; senão "outro"'),
    },
    annotations: write,
  }, wrap('add_extra', ctx, tools.addExtra))

  server.registerTool('remove_entry', {
    title: 'Desfazer lançamento',
    description: 'Desfaz um lançamento do dia: meal (apaga o registro da refeição), workout (apaga o registro do treino), extra (apaga o extra) ou move (desfaz uma troca de dia). Se já não existir, não faz nada.',
    inputSchema: {
      date,
      entry_type: z.enum(['meal', 'workout', 'extra', 'move']),
      entry_id: z.string().min(1).describe('meal_id/log_id/nome, workout_id/log_id/nome, extra_id, ou move_id/workout_id'),
    },
    annotations: { ...write, destructiveHint: true },
  }, wrap('remove_entry', ctx, tools.removeEntry))

  server.registerTool('move_workout', {
    title: 'Trocar treino de dia',
    description: 'Move o(s) treino(s) previsto(s) de from_date para to_date só naquela data (registra "movido de/para"); o plano padrão não muda. Com workout_id, move só aquele treino.',
    inputSchema: { from_date: date, to_date: date, workout_id: z.string().min(1).optional().describe('Opcional: workout_id ou nome, quando o dia tem mais de um treino') },
    annotations: write,
  }, wrap('move_workout', ctx, tools.moveWorkout))

  server.registerTool('update_plan', {
    title: 'Atualizar plano',
    description: 'Atualiza o plano semanal com um JSON no formato de importação do app (replace, settings, meals, workouts). confirm=false (padrão) devolve só a prévia das diferenças; confirm=true grava. Itens são casados por dia + nome, então reenviar o mesmo plano não muda nada.',
    inputSchema: {
      plan_json: z.union([z.string(), z.record(z.string(), z.unknown())]).describe('Plano em JSON (objeto ou texto)'),
      confirm: z.boolean().default(false).describe('true só depois que o usuário aprovar a prévia'),
    },
    annotations: { ...write, destructiveHint: true },
  }, wrap('update_plan', ctx, tools.updatePlan))

  server.registerTool('import_json', {
    title: 'Importar JSON',
    description: 'Importa lançamentos do dia (objeto com date, meals, extras, workouts, ou lista de dias) ou um plano. confirm=false devolve a prévia; confirm=true grava. Merge idempotente: o que já está igual é ignorado.',
    inputSchema: {
      payload: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).describe('JSON (objeto, lista ou texto)'),
      confirm: z.boolean().default(false),
    },
    annotations: { ...write, destructiveHint: true },
  }, wrap('import_json', ctx, tools.importJson))

  server.registerTool('get_export', {
    title: 'Exportar período',
    description: 'Gera um link temporário (1 hora) e assinado para baixar a planilha do período: xlsx (5 abas) ou csv.',
    inputSchema: { from: date, to: date, format: z.enum(['xlsx', 'csv']).default('xlsx') },
    annotations: ro,
  }, wrap('get_export', ctx, tools.getExport))

  return server
}

export function createMcpHandler(opts: McpOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    const expected = opts.token()
    if (!expected) return json({ error: 'servidor não configurado' }, 503)

    const url = new URL(req.url)
    const header = req.headers.get('authorization') ?? ''
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1]
    const pathToken = opts.allowPathToken?.() ? /^\/mcp\/([^/]+)\/?$/.exec(url.pathname)?.[1] : undefined
    const given = bearer ?? (pathToken ? decodeURIComponent(pathToken) : undefined)
    if (!given || !safeEqual(given, expected)) {
      return json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer realm="rotina"' })
    }

    // Sem sessão: não há stream SSE por GET nem sessão para encerrar por DELETE.
    if (req.method !== 'POST') return json({ error: 'método não permitido' }, 405, { allow: 'POST' })

    const now = opts.now ?? (() => new Date())
    const base = opts.baseUrl(req)
    const ctx: ToolContext = {
      store: opts.store,
      now,
      exportUrl: (from, to, format) => opts.exportUrl(base, from, to, format, now()),
    }
    try {
      const server = buildServer(ctx)
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await server.connect(transport)
      return await transport.handleRequest(req)
    } catch (err) {
      logError('transporte', err)
      return json({ jsonrpc: '2.0', error: { code: -32603, message: 'erro interno' }, id: null }, 500)
    }
  }
}
