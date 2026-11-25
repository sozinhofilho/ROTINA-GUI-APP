// Links temporários e assinados (HMAC) para baixar a exportação sem expor nenhum token.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from './server.ts'

export const EXPORT_TTL_SECONDS = 60 * 60

function secret(): string {
  const base = env('EXPORT_SECRET') ?? env('MCP_TOKEN') ?? env('APP_TOKEN')
  if (!base) throw new Error('sem segredo para assinar exportações')
  // Deriva uma chave própria: o link nunca carrega nem permite recuperar o token.
  return createHmac('sha256', base).update('rotina-export-v1').digest('hex')
}

function sign(from: string, to: string, format: string, exp: number): string {
  return createHmac('sha256', secret()).update(`${from}|${to}|${format}|${exp}`).digest('base64url')
}

export function makeExportUrl(
  baseUrl: string,
  from: string,
  to: string,
  format: 'xlsx' | 'csv',
  now: Date = new Date(),
): { url: string; expires_at: string } {
  const exp = Math.floor(now.getTime() / 1000) + EXPORT_TTL_SECONDS
  const q = new URLSearchParams({ from, to, format, exp: String(exp), sig: sign(from, to, format, exp) })
  const expires = new Date(exp * 1000)
  const expires_at = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(expires)
  return { url: `${baseUrl}/api/export-file?${q}`, expires_at }
}

export function verifyExportUrl(q: URLSearchParams, now: Date = new Date()): boolean {
  const from = q.get('from') ?? ''
  const to = q.get('to') ?? ''
  const format = q.get('format') ?? ''
  const exp = Number(q.get('exp'))
  const sig = q.get('sig') ?? ''
  if (!Number.isFinite(exp) || exp * 1000 < now.getTime()) return false
  const expected = Buffer.from(sign(from, to, format, exp))
  const got = Buffer.from(sig)
  return got.length === expected.length && timingSafeEqual(got, expected)
}
