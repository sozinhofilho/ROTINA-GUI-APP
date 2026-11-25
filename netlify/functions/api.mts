// Única Netlify Function: roteia /api/* .
// Todas as rotas exigem o header x-app-token = APP_TOKEN, exceto o callback OAuth e o webhook do Strava.
import type { Context } from '@netlify/functions'
import { addDays, diffDays, isISODate, todayISO } from '../../shared/dates.ts'
import {
  formatZodError,
  MutateBodySchema,
} from '../../shared/schemas.ts'
import * as XLSX from 'xlsx'
import { buildCsv, buildExportSheets, buildWorkbook, exportFileName } from '../../shared/export.ts'
import { makeExportUrl, verifyExportUrl } from '../lib/export-link.ts'
import { supabaseStore } from '../lib/store.ts'
import { importJson, ToolError, updatePlan, type ToolContext, type ToolResult } from '../lib/tools.ts'
import type { DataResponse } from '../../shared/types.ts'
import { applyOpDb } from '../lib/mutate.ts'
import { analyzePhoto, photoAiEnabled } from '../lib/photo-ai.ts'
import {
  checkToken,
  db,
  HttpError,
  json,
  loadData,
  env,
  PHOTO_BUCKET,
  readJson,
} from '../lib/server.ts'
import {
  authorizeUrl,
  createSubscription,
  deleteActivity,
  exchangeCode,
  importActivity,
  oauthState,
  ownerMatches,
  siteUrl,
  stravaConfigured,
  stravaConnected,
  syncRecent,
  verifyToken,
} from '../lib/strava.ts'

export const config = { path: '/api/*' }

type Handler = (req: Request, url: URL, ctx: Context) => Promise<Response>

function parseRange(url: URL): { from: string; to: string } {
  const today = todayISO()
  const from = url.searchParams.get('from') ?? addDays(today, -7)
  const to = url.searchParams.get('to') ?? addDays(today, 7)
  if (!isISODate(from) || !isISODate(to) || from > to) throw new HttpError(400, 'from/to inválidos')
  if (diffDays(from, to) > 800) throw new HttpError(400, 'intervalo grande demais')
  return { from, to }
}

const getData: Handler = async (_req, url) => {
  const { from, to } = parseRange(url)
  const data = await loadData(from, to)
  const photo_urls: Record<string, string> = {}
  const paths = url.searchParams.get('photos') === '0' ? [] : data.meal_logs.map((l) => l.photo_path).filter((p): p is string => !!p)
  if (paths.length) {
    const signed = await db().storage.from(PHOTO_BUCKET).createSignedUrls(paths.slice(0, 200), 60 * 60 * 12)
    for (const s of signed.data ?? []) if (s.path && s.signedUrl) photo_urls[s.path] = s.signedUrl
  }
  const body: DataResponse = {
    ...data,
    photo_urls,
    features: {
      photo_ai: photoAiEnabled(),
      strava_configured: stravaConfigured(),
      strava_connected: await stravaConnected().catch(() => false),
    },
  }
  return json(body)
}

const mutate: Handler = async (req) => {
  const parsed = MutateBodySchema.safeParse(await readJson(req))
  if (!parsed.success) throw new HttpError(400, formatZodError(parsed.error))
  for (const op of parsed.data.ops) await applyOpDb(op)
  return json({ ok: true, applied: parsed.data.ops.length })
}

// Importações do app usam as MESMAS funções do conector MCP (diff idempotente do plano, merge do dia).
function toolCtx(req: Request): ToolContext {
  const base = env('URL') ?? new URL(req.url).origin
  return { store: supabaseStore, now: () => new Date(), exportUrl: (f, t, fmt) => makeExportUrl(base, f, t, fmt) }
}

async function runTool(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ToolError) throw new HttpError(400, err.message)
    throw err
  }
}

const importPlan: Handler = async (req) => {
  const body = await readJson(req)
  const r = await runTool(() => updatePlan(toolCtx(req), { plan_json: body, confirm: true }))
  return json({ ok: true, operations: r.data.operations, summary: r.text })
}

const importDay: Handler = async (req) => {
  const body = await readJson(req)
  if (Array.isArray(body) || !body || typeof body !== 'object' || !('date' in body)) {
    throw new HttpError(400, 'esperado um objeto com "date"')
  }
  const r = await runTool(() => importJson(toolCtx(req), { payload: body, confirm: true }))
  return json({ ok: true, applied: r.data.operations, summary: r.text })
}

const exportFile: Handler = async (_req, url) => {
  if (!verifyExportUrl(url.searchParams)) throw new HttpError(403, 'link expirado ou inválido')
  const from = url.searchParams.get('from')!
  const to = url.searchParams.get('to')!
  const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'xlsx'
  if (!isISODate(from) || !isISODate(to) || from > to) throw new HttpError(400, 'from/to inválidos')
  const today = todayISO()
  const data = await loadData(from, to)
  const sheets = buildExportSheets(data, from, to, today)
  const name = exportFileName(from, to, today, format)
  const body =
    format === 'csv'
      ? new TextEncoder().encode(buildCsv(XLSX, sheets))
      : new Uint8Array(XLSX.write(buildWorkbook(XLSX, sheets) as XLSX.WorkBook, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
  return new Response(body, {
    headers: {
      'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    },
  })
}

const uploadPhoto: Handler = async (req, url) => {
  const date = url.searchParams.get('date') ?? ''
  if (!isISODate(date)) throw new HttpError(400, 'date inválida')
  const type = req.headers.get('content-type') ?? ''
  if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new HttpError(415, 'envie uma imagem jpeg/png/webp')
  const buf = Buffer.from(await req.arrayBuffer())
  if (buf.length === 0 || buf.length > 5 * 1024 * 1024) throw new HttpError(413, 'imagem vazia ou maior que 5 MB')
  const ext = type.split('/')[1].replace('jpeg', 'jpg')
  const path = `${date.slice(0, 7)}/${date}-${crypto.randomUUID()}.${ext}`
  const up = await db().storage.from(PHOTO_BUCKET).upload(path, buf, { contentType: type, upsert: false })
  if (up.error) throw new HttpError(500, `storage: ${up.error.message}`)
  const signed = await db().storage.from(PHOTO_BUCKET).createSignedUrl(path, 60 * 60 * 12)
  return json({ path, url: signed.data?.signedUrl ?? null })
}

const deletePhoto: Handler = async (req) => {
  const body = (await readJson(req)) as { path?: unknown }
  if (typeof body.path !== 'string' || !/^\d{4}-\d{2}\/[\w.-]+$/.test(body.path)) throw new HttpError(400, 'path inválido')
  await db().storage.from(PHOTO_BUCKET).remove([body.path])
  return json({ ok: true })
}

const analyze: Handler = async (req) => {
  if (!photoAiEnabled()) return json({ enabled: false, error: 'Análise por IA desligada' }, 403)
  const body = (await readJson(req)) as { path?: unknown; hint?: unknown }
  if (typeof body.path !== 'string' || !/^\d{4}-\d{2}\/[\w.-]+$/.test(body.path)) throw new HttpError(400, 'path inválido')
  const estimate = await analyzePhoto(body.path, typeof body.hint === 'string' ? body.hint : '')
  return json({ enabled: true, estimate })
}

// ---------- Strava ----------

function requireStrava(): void {
  if (!stravaConfigured()) throw new HttpError(400, 'Strava não configurado (STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET)')
}

const stravaConnect: Handler = async (req) => {
  requireStrava()
  return json({ url: authorizeUrl(req) })
}

const stravaCallback: Handler = async (req, url) => {
  requireStrava()
  const back = (status: string) => Response.redirect(`${siteUrl(req)}/?strava=${status}#plano`, 302)
  if (url.searchParams.get('state') !== oauthState()) return back('erro')
  const code = url.searchParams.get('code')
  const scope = url.searchParams.get('scope') ?? ''
  if (!code || !scope.includes('activity:read')) return back('negado')
  await exchangeCode(code)
  return back('ok')
}

const stravaWebhook: Handler = async (req, url, ctx) => {
  if (req.method === 'GET') {
    if (url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === verifyToken()) {
      return json({ 'hub.challenge': url.searchParams.get('hub.challenge') })
    }
    return json({ error: 'verify_token inválido' }, 403)
  }
  const ev = (await readJson(req)) as {
    object_type?: string
    aspect_type?: string
    object_id?: number
    owner_id?: number
  }
  // Responde rápido (Strava exige < 2 s) e processa em segundo plano.
  if (ev.object_type === 'activity' && typeof ev.object_id === 'number' && typeof ev.owner_id === 'number') {
    const work = (async () => {
      if (!(await ownerMatches(ev.owner_id!))) return
      if (ev.aspect_type === 'delete') await deleteActivity(ev.object_id!)
      else await importActivity(ev.object_id!)
    })().catch((err) => console.error('strava webhook:', err instanceof Error ? err.constructor.name : 'erro'))
    ctx.waitUntil(work)
  }
  return json({ ok: true })
}

const stravaSubscribe: Handler = async (req) => {
  requireStrava()
  return json(await createSubscription(req))
}

const stravaSync: Handler = async (_req, url) => {
  requireStrava()
  const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days') ?? 7)))
  return json(await syncRecent(days))
}

const routes: Record<string, { method: string[]; handler: Handler; public?: boolean }> = {
  '/api/data': { method: ['GET'], handler: getData },
  '/api/mutate': { method: ['POST'], handler: mutate },
  '/api/import-plan': { method: ['POST'], handler: importPlan },
  '/api/import-day': { method: ['POST'], handler: importDay },
  '/api/export-file': { method: ['GET'], handler: exportFile, public: true },
  '/api/photo': { method: ['POST'], handler: uploadPhoto },
  '/api/photo/delete': { method: ['POST'], handler: deletePhoto },
  '/api/analyze-photo': { method: ['POST'], handler: analyze },
  '/api/strava/connect': { method: ['GET'], handler: stravaConnect },
  '/api/strava/callback': { method: ['GET'], handler: stravaCallback, public: true },
  '/api/strava/webhook': { method: ['GET', 'POST'], handler: stravaWebhook, public: true },
  '/api/strava/subscribe': { method: ['POST'], handler: stravaSubscribe },
  '/api/strava/sync': { method: ['POST'], handler: stravaSync },
}

export default async (req: Request, ctx: Context): Promise<Response> => {
  const url = new URL(req.url)
  const route = routes[url.pathname.replace(/\/+$/, '')]
  try {
    if (!route) throw new HttpError(404, 'rota não encontrada')
    if (!route.method.includes(req.method)) throw new HttpError(405, 'método não permitido')
    if (!route.public) checkToken(req)
    return await route.handler(req, url, ctx)
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status)
    // Só o tipo do erro: mensagens do banco podem conter dados de saúde.
    console.error('api:', err instanceof Error ? err.constructor.name : 'erro')
    return json({ error: 'erro interno' }, 500)
  }
}
