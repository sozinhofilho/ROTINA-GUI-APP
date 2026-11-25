// Chamadas às Functions, sempre com o token secreto no header.

const TOKEN_KEY = 'rotina:token'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Lê ?k=TOKEN na primeira abertura, guarda e limpa da URL. */
export function bootstrapToken(): string | null {
  const url = new URL(window.location.href)
  const k = url.searchParams.get('k')
  if (k) {
    try {
      localStorage.setItem(TOKEN_KEY, k)
    } catch {
      /* sem storage: segue só nesta sessão */
    }
    url.searchParams.delete('k')
    window.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash)
    memoryToken = k
    return k
  }
  memoryToken = safeGet(TOKEN_KEY)
  return memoryToken
}

let memoryToken: string | null = null

/** Usado só pela demonstração, que não tem link secreto. */
export function setMemoryToken(t: string): void {
  memoryToken = t
}

export function getToken(): string | null {
  return memoryToken
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('x-app-token', memoryToken ?? '')
  if (init.body && typeof init.body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  let res: Response
  try {
    res = await fetch(path, { ...init, headers })
  } catch {
    throw new ApiError(0, 'sem conexão')
  }
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`
    throw new ApiError(res.status, msg)
  }
  return body as T
}

export const postJson = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) })
