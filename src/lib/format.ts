export function toIntOrNull(s: string): number | null {
  const t = s.trim().replace(',', '.')
  if (!t) return null
  const n = Math.round(Number(t))
  return Number.isFinite(n) && n >= 0 ? n : null
}

export function fmt(n: number): string {
  return n.toLocaleString('pt-BR')
}
