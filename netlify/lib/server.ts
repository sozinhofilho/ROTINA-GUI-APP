// Utilitários das Functions: auth por token, Supabase (service role), respostas JSON.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { timingSafeEqual, createHash } from 'node:crypto'
import type { AppData, Settings } from '../../shared/types.ts'
import { DEFAULT_SETTINGS } from '../../shared/types.ts'

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })
}

export function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}

function sha(s: string): Buffer {
  return createHash('sha256').update(s).digest()
}

/** Compara o token enviado com APP_TOKEN em tempo constante. */
export function checkToken(req: Request): void {
  const expected = env('APP_TOKEN')
  if (!expected) throw new HttpError(500, 'APP_TOKEN não configurado')
  const got = req.headers.get('x-app-token') ?? ''
  if (!got || !timingSafeEqual(sha(got), sha(expected))) throw new HttpError(401, 'token inválido')
}

let client: SupabaseClient | null = null
export function db(): SupabaseClient {
  if (client) return client
  const url = env('SUPABASE_URL')
  const key = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) throw new HttpError(500, 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não configurados')
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return client
}

export const PHOTO_BUCKET = 'photos'

/** Lança HttpError se o Supabase devolver erro. */
export function must<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new HttpError(500, `banco: ${res.error.message}`)
  return res.data
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

export async function loadSettings(): Promise<Settings> {
  const row = must(await db().from('settings').select('*').eq('id', 1).maybeSingle()) as Record<string, unknown> | null
  if (!row) return DEFAULT_SETTINGS
  return {
    calorie_goal: Number(row.calorie_goal),
    tolerance_pct: Number(row.tolerance_pct),
    base_expenditure: num(row.base_expenditure),
    timezone: String(row.timezone || DEFAULT_SETTINGS.timezone),
    water_goal_ml: row.water_goal_ml == null ? DEFAULT_SETTINGS.water_goal_ml : Number(row.water_goal_ml),
  }
}

/** Carrega plano + registros entre from e to (inclusive). Postgres devolve numeric como string: normaliza. */
export async function loadData(from: string, to: string): Promise<AppData> {
  const s = db()
  const [settings, meals, workouts, overrides, mealLogs, workoutLogs, extras, water, body] = await Promise.all([
    loadSettings(),
    s.from('plan_meals').select('*').order('weekday').order('time'),
    s.from('plan_workouts').select('*').order('weekday').order('sort'),
    s.from('day_overrides').select('*').or(`and(from_date.gte.${from},from_date.lte.${to}),and(to_date.gte.${from},to_date.lte.${to})`),
    s.from('meal_logs').select('*').gte('date', from).lte('date', to),
    s.from('workout_logs').select('*').gte('date', from).lte('date', to),
    s.from('extra_entries').select('*').gte('date', from).lte('date', to),
    s.from('water_logs').select('date, ml').gte('date', from).lte('date', to),
    s.from('body_checkins').select('*').gte('date', from).lte('date', to),
  ])
  type Row = Record<string, unknown>
  return {
    settings,
    plan_meals: (must(meals) as Row[]).map((r) => ({
      id: String(r.id), weekday: Number(r.weekday), name: String(r.name), time: String(r.time),
      description: String(r.description ?? ''), items: (r.items as never) ?? [], kcal: Number(r.kcal),
      protein: num(r.protein), carbs: num(r.carbs), fat: num(r.fat), sort: Number(r.sort),
    })),
    plan_workouts: (must(workouts) as Row[]).map((r) => ({
      id: String(r.id), weekday: Number(r.weekday), name: String(r.name), kind: r.kind as never,
      time: (r.time as string | null) ?? null, details: String(r.details ?? ''), exercises: (r.exercises as never) ?? [],
      duration_min: num(r.duration_min), kcal: num(r.kcal), sort: Number(r.sort),
    })),
    overrides: (must(overrides) as Row[]).map((r) => ({
      id: String(r.id), plan_workout_id: String(r.plan_workout_id), from_date: String(r.from_date), to_date: String(r.to_date),
    })),
    meal_logs: (must(mealLogs) as Row[]).map((r) => ({
      id: String(r.id), date: String(r.date), plan_meal_id: (r.plan_meal_id as string | null) ?? null,
      meal_name: String(r.meal_name ?? ''), done: Boolean(r.done), kcal_planned: num(r.kcal_planned),
      kcal_real: num(r.kcal_real), note: String(r.note ?? ''), photo_path: (r.photo_path as string | null) ?? null,
      ai_estimate: (r.ai_estimate as never) ?? null,
    })),
    workout_logs: (must(workoutLogs) as Row[]).map((r) => ({
      id: String(r.id), date: String(r.date), plan_workout_id: (r.plan_workout_id as string | null) ?? null,
      name: String(r.name ?? ''), done: Boolean(r.done), duration_min: num(r.duration_min), kcal: num(r.kcal),
      distance_m: num(r.distance_m), avg_hr: num(r.avg_hr), avg_pace: (r.avg_pace as string | null) ?? null, note: String(r.note ?? ''), source: r.source as never,
      strava_activity_id: num(r.strava_activity_id),
    })),
    extras: (must(extras) as Row[]).map((r) => ({
      id: String(r.id), date: String(r.date), time: (r.time as string | null) ?? null,
      description: String(r.description), kcal: Number(r.kcal), category: r.category as never,
    })),
    water: (must(water) as Row[]).map((r) => ({ date: String(r.date), ml: Number(r.ml) })),
    body: (must(body) as Row[]).map((r) => ({
      id: String(r.id), date: String(r.date), weight_kg: num(r.weight_kg),
      photo_front: (r.photo_front as string | null) ?? null, photo_side: (r.photo_side as string | null) ?? null,
      note: String(r.note ?? ''),
    })),
  }
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw new HttpError(400, 'JSON inválido')
  }
}

/** Primeira data com qualquer registro (para a visão acumulada). */
export async function firstDate(): Promise<string | null> {
  const s = db()
  const results = await Promise.all(
    ['meal_logs', 'workout_logs', 'extra_entries', 'water_logs', 'body_checkins'].map((t) =>
      s.from(t).select('date').order('date', { ascending: true }).limit(1),
    ),
  )
  const dates = results.flatMap((r) => (r.data as { date: string }[] | null) ?? []).map((r) => String(r.date))
  return dates.length ? dates.sort()[0] : null
}
