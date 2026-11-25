// Estado global: cache dos dados, fila offline de operações e sincronização.
import { useSyncExternalStore } from 'react'
import type { Op } from '../../shared/schemas.ts'
import { applyOp } from '../../shared/logic.ts'
import type { AppData, DataResponse } from '../../shared/types.ts'
import { DEFAULT_SETTINGS } from '../../shared/types.ts'
import { api, ApiError, postJson } from './api.ts'

type Features = DataResponse['features']

export interface State {
  server: AppData | null
  view: AppData | null
  photoUrls: Record<string, string>
  features: Features
  ranges: { from: string; to: string; at: number }[]
  pending: Op[]
  syncing: boolean
  online: boolean
  loading: boolean
  authError: boolean
  toast: { text: string; kind: 'ok' | 'erro' } | null
}

const CACHE_KEY = 'rotina:cache:v1'
const QUEUE_KEY = 'rotina:queue:v1'

const EMPTY: AppData = {
  settings: DEFAULT_SETTINGS,
  plan_meals: [],
  plan_workouts: [],
  overrides: [],
  meal_logs: [],
  workout_logs: [],
  extras: [],
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage cheio ou bloqueado: segue em memória */
  }
}

const cached = load<{ server: AppData | null; features?: Features }>(CACHE_KEY, { server: null })
const initialPending = load<Op[]>(QUEUE_KEY, [])

let state: State = {
  server: cached.server,
  view: cached.server ? initialPending.reduce(applyOp, cached.server) : null,
  photoUrls: {},
  features: cached.features ?? { photo_ai: false, strava_configured: false, strava_connected: false },
  ranges: [],
  pending: initialPending,
  syncing: false,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  loading: false,
  authError: false,
  toast: null,
}

const listeners = new Set<() => void>()
function set(patch: Partial<State>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function getState(): State {
  return state
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => selector(state),
  )
}

function recompute(server: AppData | null, pending: Op[]): AppData | null {
  if (!server) return pending.length ? pending.reduce(applyOp, EMPTY) : null
  return pending.reduce(applyOp, server)
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function toast(text: string, kind: 'ok' | 'erro' = 'ok'): void {
  clearTimeout(toastTimer)
  set({ toast: { text, kind } })
  toastTimer = setTimeout(() => set({ toast: null }), kind === 'erro' ? 5000 : 2500)
}

function mergeServer(prev: AppData | null, resp: AppData, from: string, to: string): AppData {
  const inRange = (d: string) => d >= from && d <= to
  const keep = <T extends { date: string }>(list: T[] | undefined) => (list ?? []).filter((x) => !inRange(x.date))
  const freshIds = new Set(resp.overrides.map((o) => o.id))
  return {
    settings: resp.settings,
    plan_meals: resp.plan_meals,
    plan_workouts: resp.plan_workouts,
    overrides: [
      ...(prev?.overrides ?? []).filter((o) => !freshIds.has(o.id) && !inRange(o.from_date) && !inRange(o.to_date)),
      ...resp.overrides,
    ],
    meal_logs: [...keep(prev?.meal_logs), ...resp.meal_logs],
    workout_logs: [...keep(prev?.workout_logs), ...resp.workout_logs],
    extras: [...keep(prev?.extras), ...resp.extras],
  }
}

const inflight = new Map<string, Promise<void>>()

/** Busca do servidor o intervalo (se não estiver fresco no cache). */
export function ensureRange(from: string, to: string, opts: { force?: boolean; maxAgeMs?: number; photos?: boolean } = {}): Promise<void> {
  const maxAge = opts.maxAgeMs ?? 60_000
  const fresh = state.ranges.some((r) => r.from <= from && r.to >= to && Date.now() - r.at < maxAge)
  if (fresh && !opts.force) return Promise.resolve()
  const key = `${from}|${to}`
  const existing = inflight.get(key)
  if (existing) return existing
  const p = (async () => {
    set({ loading: true })
    try {
      const resp = await api<DataResponse>(
        `/api/data?from=${from}&to=${to}${opts.photos === false ? '&photos=0' : ''}`,
      )
      // Envia o que estiver na fila antes de sobrescrever com o servidor.
      const server = mergeServer(state.server, resp, from, to)
      set({
        server,
        view: recompute(server, state.pending),
        photoUrls: { ...state.photoUrls, ...resp.photo_urls },
        features: resp.features,
        ranges: [...state.ranges.filter((r) => !(r.from >= from && r.to <= to)), { from, to, at: Date.now() }],
        online: true,
        authError: false,
      })
      save(CACHE_KEY, { server, features: resp.features })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) set({ authError: true })
      else if (err instanceof ApiError && err.status === 0) set({ online: false })
      else toast(`Erro ao carregar: ${(err as Error).message}`, 'erro')
    } finally {
      inflight.delete(key)
      set({ loading: false })
    }
  })()
  inflight.set(key, p)
  return p
}

/** Aplica localmente na hora e coloca na fila de sincronização. */
export function dispatch(ops: Op | Op[]): void {
  const list = Array.isArray(ops) ? ops : [ops]
  const pending = [...state.pending, ...list]
  save(QUEUE_KEY, pending)
  set({ pending, view: recompute(state.server, pending) })
  void flush()
}

let retryTimer: ReturnType<typeof setTimeout> | undefined

export async function flush(): Promise<void> {
  if (state.syncing || state.pending.length === 0) return
  clearTimeout(retryTimer)
  set({ syncing: true })
  const batch = state.pending.slice(0, 100)
  let sent: Op[] = []
  let dropped: Op[] = []
  try {
    try {
      await postJson('/api/mutate', { ops: batch })
      sent = batch
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 400) throw err
      // Lote rejeitado: manda uma por uma para descartar só as inválidas.
      for (const op of batch) {
        try {
          await postJson('/api/mutate', { ops: [op] })
          sent.push(op)
        } catch (e) {
          if (e instanceof ApiError && e.status === 400) {
            dropped.push(op)
            toast(`Registro rejeitado: ${e.message}`, 'erro')
          } else throw e
        }
      }
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) set({ authError: true })
    else set({ online: err instanceof ApiError && err.status === 0 ? false : state.online })
    retryTimer = setTimeout(() => void flush(), 20_000)
  } finally {
    const done = new Set<Op>([...sent, ...dropped])
    const pending = state.pending.filter((op) => !done.has(op))
    const server = state.server ? sent.reduce(applyOp, state.server) : state.server
    save(QUEUE_KEY, pending)
    if (server) save(CACHE_KEY, { server, features: state.features })
    set({ pending, server, view: recompute(server, pending), syncing: false, online: sent.length ? true : state.online })
    sent = []
    dropped = []
  }
  if (state.pending.length && state.online) void flush()
}

export function setPhotoUrl(path: string, url: string): void {
  set({ photoUrls: { ...state.photoUrls, [path]: url } })
}

/** Invalida o cache (após importações feitas direto no servidor). */
export function invalidate(): void {
  set({ ranges: [] })
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    set({ online: true })
    void flush()
  })
  window.addEventListener('offline', () => set({ online: false }))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flush()
  })
}
