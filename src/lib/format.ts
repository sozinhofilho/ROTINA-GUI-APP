export function toIntOrNull(s: string): number | null {
  const t = s.trim().replace(',', '.')
  if (!t) return null
  const n = Math.round(Number(t))
  return Number.isFinite(n) && n >= 0 ? n : null
}

export function fmt(n: number): string {
  return n.toLocaleString('pt-BR')
}

export function formatKg(n: number): string {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

/** "84,5" ou "84.5" → 84.5; fora de 20–400 kg → null. */
export function parseKg(s: string): number | null {
  const t = s.trim().replace(',', '.')
  if (!t) return null
  const n = Math.round(Number(t) * 10) / 10
  return Number.isFinite(n) && n >= 20 && n <= 400 ? n : null
}
