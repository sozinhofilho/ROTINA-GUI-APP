// Fase 2: integração com o Strava (OAuth, webhook e sincronização manual).
import { createHash } from 'node:crypto'
import { expandDay } from '../../shared/calc.ts'
import { pickWorkoutForActivity } from '../../shared/logic.ts'
import type { WorkoutLog } from '../../shared/types.ts'
import { db, env, HttpError, loadData, must } from './server.ts'

const API = 'https://www.strava.com/api/v3'

export function stravaConfigured(): boolean {
  return Boolean(env('STRAVA_CLIENT_ID') && env('STRAVA_CLIENT_SECRET'))
}

export function siteUrl(req: Request): string {
  return env('URL') ?? new URL(req.url).origin
}

/** state do OAuth derivado do APP_TOKEN (não expõe o token). */
export function oauthState(): string {
  return createHash('sha256').update(`strava-state:${env('APP_TOKEN') ?? ''}`).digest('hex').slice(0, 32)
}

export function verifyToken(): string {
  return env('STRAVA_VERIFY_TOKEN') ?? createHash('sha256').update(`strava-verify:${env('APP_TOKEN') ?? ''}`).digest('hex').slice(0, 24)
}

export function authorizeUrl(req: Request): string {
  const p = new URLSearchParams({
    client_id: env('STRAVA_CLIENT_ID')!,
    redirect_uri: `${siteUrl(req)}/api/strava/callback`,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
    state: oauthState(),
  })
  return `https://www.strava.com/oauth/authorize?${p}`
}

interface TokenRow {
  athlete_id: number
  access_token: string
  refresh_token: string
  expires_at: number
}

async function tokenRequest(params: Record<string, string>): Promise<{
  access_token: string
  refresh_token: string
  expires_at: number
  athlete?: { id: number }
}> {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('STRAVA_CLIENT_ID')!,
      client_secret: env('STRAVA_CLIENT_SECRET')!,
      ...params,
    }),
  })
  if (!res.ok) throw new HttpError(502, `Strava token: HTTP ${res.status}`)
  return res.json()
}

export async function exchangeCode(code: string): Promise<void> {
  const t = await tokenRequest({ code, grant_type: 'authorization_code' })
  if (!t.athlete) throw new HttpError(502, 'Strava não devolveu o atleta')
  must(
    await db().from('strava_tokens').upsert({
      id: 1,
      athlete_id: t.athlete.id,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: t.expires_at,
      updated_at: new Date().toISOString(),
    }),
  )
}

export async function stravaConnected(): Promise<boolean> {
  if (!stravaConfigured()) return false
  const row = must(await db().from('strava_tokens').select('athlete_id').eq('id', 1).maybeSingle())
  return Boolean(row)
}

async function accessToken(): Promise<TokenRow> {
  const row = must(await db().from('strava_tokens').select('*').eq('id', 1).maybeSingle()) as TokenRow | null
  if (!row) throw new HttpError(400, 'Strava não conectado')
  if (Number(row.expires_at) - 120 > Date.now() / 1000) return row
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: row.refresh_token })
  const next = { ...row, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at }
  must(await db().from('strava_tokens').update({ ...next, updated_at: new Date().toISOString() }).eq('id', 1))
  return next
}

async function stravaGet<T>(path: string): Promise<T> {
  const tok = await accessToken()
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${tok.access_token}` } })
  if (res.status === 404) throw new HttpError(404, 'atividade não encontrada')
  if (!res.ok) throw new HttpError(502, `Strava ${path}: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

interface Activity {
  id: number
  name: string
  sport_type?: string
  type?: string
  start_date_local: string
  moving_time: number
  elapsed_time: number
  distance: number
  calories?: number
  kilojoules?: number
  average_heartrate?: number
}

/** Importa uma atividade e marca o treino previsto que ela cumpre. */
export async function importActivity(activityId: number): Promise<{ date: string; matched: string | null }> {
  const a = await stravaGet<Activity>(`/activities/${activityId}`)
  const date = a.start_date_local.slice(0, 10)
  const sport = a.sport_type ?? a.type ?? 'Workout'
  const s = db()

  const existing = must(
    await s.from('workout_logs').select('*').eq('strava_activity_id', a.id).maybeSingle(),
  ) as WorkoutLog | null

  let planWorkoutId: string | null = existing?.plan_workout_id ?? null
  let name = existing?.name || a.name
  let targetId: string | null = existing?.id ?? null

  if (!existing || existing.date !== date) {
    const data = await loadData(date, date)
    const day = expandDay(date, data)
    const pick = pickWorkoutForActivity(day.workouts, sport)
    planWorkoutId = pick?.plan?.id ?? null
    name = pick?.plan?.name ?? a.name
    if (pick?.log) {
      if (existing) must(await s.from('workout_logs').delete().eq('id', existing.id))
      targetId = pick.log.id
    }
  }

  const calories = a.calories ?? (a.kilojoules ? Math.round(a.kilojoules / 4.184 / 0.25) : null)
  const row = {
    id: targetId ?? crypto.randomUUID(),
    date,
    plan_workout_id: planWorkoutId,
    name,
    done: true,
    duration_min: Math.round((a.moving_time || a.elapsed_time) / 60),
    kcal: calories != null ? Math.round(calories) : null,
    distance_m: a.distance ?? null,
    avg_hr: a.average_heartrate ?? null,
    note: `Strava: ${a.name}`,
    source: 'strava',
    strava_activity_id: a.id,
    updated_at: new Date().toISOString(),
  }
  must(await s.from('workout_logs').upsert(row, { onConflict: 'id' }))
  return { date, matched: planWorkoutId ? name : null }
}

export async function deleteActivity(activityId: number): Promise<void> {
  must(await db().from('workout_logs').delete().eq('strava_activity_id', activityId).eq('source', 'strava'))
}

/** Busca atividades recentes (1 chamada de lista + 1 por atividade nova). */
export async function syncRecent(days = 7): Promise<{ imported: number }> {
  const after = Math.floor(Date.now() / 1000) - days * 86400
  const list = await stravaGet<Activity[]>(`/athlete/activities?after=${after}&per_page=30`)
  const ids = list.map((a) => a.id)
  if (!ids.length) return { imported: 0 }
  const known = must(await db().from('workout_logs').select('strava_activity_id').in('strava_activity_id', ids)) as {
    strava_activity_id: number
  }[]
  const knownSet = new Set(known.map((k) => Number(k.strava_activity_id)))
  const fresh = list.filter((a) => !knownSet.has(a.id)).slice(0, 15)
  // Ordem cronológica para casar os treinos do dia na ordem certa.
  fresh.sort((x, y) => x.start_date_local.localeCompare(y.start_date_local))
  for (const a of fresh) await importActivity(a.id)
  return { imported: fresh.length }
}

export async function ownerMatches(ownerId: number): Promise<boolean> {
  const row = must(await db().from('strava_tokens').select('athlete_id').eq('id', 1).maybeSingle()) as
    | { athlete_id: number }
    | null
  return Boolean(row && Number(row.athlete_id) === Number(ownerId))
}

export async function createSubscription(req: Request): Promise<unknown> {
  const res = await fetch(`${API}/push_subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('STRAVA_CLIENT_ID')!,
      client_secret: env('STRAVA_CLIENT_SECRET')!,
      callback_url: `${siteUrl(req)}/api/strava/webhook`,
      verify_token: verifyToken(),
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new HttpError(502, `Strava subscription: HTTP ${res.status} ${JSON.stringify(body)}`)
  return body
}
