// Datas sempre como string ISO 'YYYY-MM-DD' (dia civil no fuso configurado).

export const TZ = 'America/Sao_Paulo'

export function todayISO(tz: string = TZ, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

export function nowHHMM(tz: string = TZ, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)
}

function toUTC(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`)
}

export function isISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = toUTC(s)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export function addDays(iso: string, n: number): string {
  const d = toUTC(iso)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function weekdayOf(iso: string): number {
  return toUTC(iso).getUTCDay()
}

/** Segunda-feira da semana que contém a data. */
export function weekStart(iso: string): string {
  const wd = weekdayOf(iso)
  return addDays(iso, wd === 0 ? -6 : 1 - wd)
}

export function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`
}

export function monthEnd(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  const d = new Date(Date.UTC(y, m, 0, 12))
  return d.toISOString().slice(0, 10)
}

export function dateRange(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

export function diffDays(a: string, b: string): number {
  return Math.round((toUTC(b).getTime() - toUTC(a).getTime()) / 86_400_000)
}

export const WEEKDAY_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
export const WEEKDAY_LONG = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
]
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

/** "Qua, 25 nov" */
export function formatDayLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number)
  return `${WEEKDAY_SHORT[weekdayOf(iso)]}, ${d} ${MONTHS[m - 1]}`
}

/** "25/11" */
export function formatShort(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
}

/** "25/11/2026" */
export function formatBR(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
}
