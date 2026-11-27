// Saldo calórico (aba Evolução, tela Hoje, conector MCP e Excel usam só este módulo).
//
// Por dia com registro de comida:
//   gasto_total = gasto basal (Ajustes) + kcal dos treinos feitos (valor real; estimativa do plano só sem valor real)
//   saldo       = kcal consumidas (refeições + extras) − gasto_total   (negativo = déficit)
// Dias sem registro de comida não entram em médias nem no saldo.
// O dia de hoje fica "em andamento": não entra nas médias e ganha uma projeção.
import { expandDay, type DayView } from './calc.ts'
import { addDays, dateRange, monthEnd, monthStart, weekStart } from './dates.ts'
import type { AppData } from './types.ts'

/** kcal por kg de gordura corporal (aproximação clássica; é uma estimativa). */
export const KCAL_PER_KG_FAT = 7700

export interface BalanceDay {
  date: string
  inProgress: boolean
  hasFood: boolean
  kcalIn: number
  kcalWorkouts: number
  /** Parte das kcal de treino que veio da estimativa do plano (sem valor real). */
  kcalWorkoutsEstimated: number
  base: number | null
  spent: number | null
  balance: number | null
  workoutsPlanned: number
  workoutsDone: number
  missedWorkouts: string[]
  pendingWorkouts: string[]
  /** Só no dia em andamento: se as refeições restantes forem feitas como no plano. */
  projection: { kcalIn: number; balance: number | null; remainingMeals: string[] } | null
}

export interface BalanceSummary {
  from: string
  to: string
  base: number | null
  /** Dias já encerrados no período (até ontem, ou até `to` se o período já passou). */
  closedDays: number
  daysWithFood: number
  daysWithoutFood: number
  workoutsPlanned: number
  workoutsDone: number
  missedWorkouts: { date: string; name: string }[]
  workoutKcalTotal: number
  workoutKcalEstimated: number
  workoutKcalAvgPerDay: number
  avgKcalIn: number | null
  avgSpent: number | null
  avgBalance: number | null
  totalBalance: number | null
  fatKg: number | null
  deficitDays: number
  surplusDays: number
  today: BalanceDay | null
  daily: BalanceDay[]
}

export function balanceDay(view: DayView, today: string): BalanceDay {
  const s = view.stats
  const inProgress = view.date === today
  const hasFood = s.hasRecord
  const base = s.base
  const spent = base != null ? base + s.kcalWorkouts : null
  const balance = spent != null && hasFood ? s.kcalIn - spent : null
  const planned = view.workouts.filter((w) => w.plan)
  const notDone = planned.filter((w) => !w.log?.done).map((w) => w.plan!.name)
  let projection: BalanceDay['projection'] = null
  if (inProgress) {
    const remaining = view.meals.filter((m) => m.plan && !m.log?.done)
    const kcalIn = s.kcalIn + remaining.reduce((a, m) => a + (m.plan?.kcal ?? 0), 0)
    projection = { kcalIn, balance: spent != null ? kcalIn - spent : null, remainingMeals: remaining.map((m) => m.name) }
  }
  return {
    date: view.date,
    inProgress,
    hasFood,
    kcalIn: s.kcalIn,
    kcalWorkouts: s.kcalWorkouts,
    kcalWorkoutsEstimated: s.kcalWorkoutsEstimated,
    base,
    spent,
    balance,
    workoutsPlanned: planned.length,
    workoutsDone: s.workoutsPlannedDone,
    missedWorkouts: inProgress ? [] : notDone,
    pendingWorkouts: inProgress ? notDone : [],
    projection,
  }
}

const round = (n: number) => Math.round(n)

export function energyBalance(from: string, to: string, data: AppData, today: string): BalanceSummary {
  const lastClosed = addDays(today, -1)
  const closedEnd = to < lastClosed ? to : lastClosed
  const closed = from <= closedEnd ? dateRange(from, closedEnd).map((d) => balanceDay(expandDay(d, data), today)) : []
  const todayDay = today >= from && today <= to ? balanceDay(expandDay(today, data), today) : null
  const food = closed.filter((d) => d.hasFood)
  const base = data.settings.base_expenditure
  const withBalance = food.filter((d) => d.balance != null)
  const sum = (arr: BalanceDay[], f: (d: BalanceDay) => number) => arr.reduce((a, d) => a + f(d), 0)
  const totalBalance = base != null && withBalance.length ? sum(withBalance, (d) => d.balance!) : null
  const workoutKcalTotal = sum(closed, (d) => d.kcalWorkouts)
  return {
    from,
    to,
    base,
    closedDays: closed.length,
    daysWithFood: food.length,
    daysWithoutFood: closed.length - food.length,
    workoutsPlanned: sum(closed, (d) => d.workoutsPlanned),
    workoutsDone: sum(closed, (d) => d.workoutsDone),
    missedWorkouts: closed.flatMap((d) => d.missedWorkouts.map((name) => ({ date: d.date, name }))),
    workoutKcalTotal,
    workoutKcalEstimated: sum(closed, (d) => d.kcalWorkoutsEstimated),
    workoutKcalAvgPerDay: closed.length ? round(workoutKcalTotal / closed.length) : 0,
    avgKcalIn: food.length ? round(sum(food, (d) => d.kcalIn) / food.length) : null,
    avgSpent: base != null && food.length ? round(sum(food, (d) => d.spent!) / food.length) : null,
    avgBalance: totalBalance != null ? round(totalBalance / withBalance.length) : null,
    totalBalance,
    fatKg: totalBalance != null ? Math.round((totalBalance / KCAL_PER_KG_FAT) * 100) / 100 : null,
    deficitDays: withBalance.filter((d) => d.balance! < 0).length,
    surplusDays: withBalance.filter((d) => d.balance! > 0).length,
    today: todayDay,
    daily: todayDay ? [...closed, todayDay] : closed,
  }
}

/** Período anterior de mesmo tipo (semana → semana anterior, mês → mês anterior). */
export function previousPeriod(mode: 'semana' | 'mes', from: string): { from: string; to: string } {
  if (mode === 'semana') {
    const f = addDays(weekStart(from), -7)
    return { from: f, to: addDays(f, 6) }
  }
  const prev = addDays(monthStart(from), -1)
  return { from: monthStart(prev), to: monthEnd(prev) }
}

/** Uma linha por semana para a planilha (aba Evolução). */
export function weeklyBalance(from: string, to: string, data: AppData, today: string): (BalanceSummary & { weekStart: string })[] {
  const out: (BalanceSummary & { weekStart: string })[] = []
  const end = to < today ? to : today
  for (let ws = weekStart(from); ws <= end; ws = addDays(ws, 7)) {
    out.push({ ...energyBalance(ws < from ? from : ws, addDays(ws, 6) > to ? to : addDays(ws, 6), data, today), weekStart: ws })
  }
  return out
}

const n = (v: number) => v.toLocaleString('pt-BR')
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${n(Math.abs(v))}`

/** Texto curto (conector MCP). */
export function balanceText(b: BalanceSummary, prev: BalanceSummary | null): string {
  if (b.base == null) return 'Saldo calórico: defina o gasto basal em Ajustes (Plano) para calcular.'
  const lines: string[] = []
  if (b.daysWithFood) {
    lines.push(
      `Saldo: ${signed(b.totalBalance!)} kcal acumulado (${signed(b.avgBalance!)} kcal/dia) em ${b.daysWithFood} dia(s) com registro · ≈ ${signed(b.fatKg!).replace('.', ',')} kg de gordura (estimativa).`,
      `Consumo médio ${n(b.avgKcalIn!)} kcal · gasto total médio ${n(b.avgSpent!)} kcal (basal ${n(b.base)} + treino). Déficit em ${b.deficitDays} dia(s), superávit em ${b.surplusDays}.`,
    )
  } else lines.push('Saldo: nenhum dia encerrado com registro de comida no período.')
  if (b.daysWithoutFood) lines.push(`${b.daysWithoutFood} dia(s) sem registro de comida (fora das médias).`)
  lines.push(
    `Treinos: ${b.workoutsDone}/${b.workoutsPlanned} feitos · ${n(b.workoutKcalTotal)} kcal em treino (${n(b.workoutKcalAvgPerDay)}/dia)${b.workoutKcalEstimated ? `, ${n(b.workoutKcalEstimated)} kcal estimadas pelo plano` : ''}.${b.missedWorkouts.length ? ` Faltaram: ${b.missedWorkouts.map((m) => `${m.name} (${m.date.slice(8)}/${m.date.slice(5, 7)})`).join(', ')}.` : ''}`,
  )
  if (prev && prev.avgBalance != null && b.avgBalance != null) {
    lines.push(`Período anterior: saldo médio ${signed(prev.avgBalance)} kcal/dia (agora ${signed(b.avgBalance)}).`)
  }
  if (b.today) {
    const t = b.today
    const p = t.projection
    lines.push(
      `Hoje (em andamento): consumido ${n(t.kcalIn)}, gasto ${n(t.spent!)}${t.balance != null ? `, saldo ${signed(t.balance)}` : ''}${p?.balance != null && p.remainingMeals.length ? `; se fizer ${p.remainingMeals.join(', ')} como no plano, fecha em ${signed(p.balance)}` : ''}.`,
    )
  }
  return lines.join('\n')
}
