// Fechamento de período (semana, mês, acumulado): nota de assertividade, pilares,
// o que funcionou, onde falhou e evolução do peso. Usado pela tela Resumo e pelo conector MCP.
import { expandDay, summarize, type DayStats } from './calc.ts'
import { addDays, formatShort, weekdayOf, weekStart, WEEKDAY_SHORT } from './dates.ts'
import type { AppData } from './types.ts'

export interface Pillar {
  key: 'kcal' | 'meals' | 'workouts' | 'water'
  label: string
  done: number
  total: number
  pct: number
}

export interface WeightPoint {
  date: string
  kg: number
}

export interface WeightChange {
  label: string
  from: WeightPoint
  to: WeightPoint
  delta: number
}

export interface Review {
  from: string
  to: string
  days: number
  score: number | null
  verdict: string
  pillars: Pillar[]
  avgKcalIn: number
  goal: number
  daysAbove: number
  daysBelow: number
  extrasKcal: number
  alcoholKcal: number
  avgWaterMl: number
  weights: WeightPoint[]
  weightDelta: number | null
  weightChanges: WeightChange[]
  wins: string[]
  misses: string[]
  daily: DayStats[]
}

const n = (v: number) => v.toLocaleString('pt-BR')
const kg = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const signedKg = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${kg(Math.abs(v))} kg`
const liters = (ml: number) => (ml / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })
const dayName = (d: string) => `${WEEKDAY_SHORT[weekdayOf(d)]} ${formatShort(d)}`
const pct = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0)

function listDays(days: string[], max = 4): string {
  const names = days.map(dayName)
  return names.length > max ? `${names.slice(0, max).join(', ')} e mais ${names.length - max}` : names.join(', ')
}

export function verdictFor(score: number | null, unit: 'Semana' | 'Mês' | 'Período'): string {
  if (score == null) return 'Sem dados ainda'
  if (score >= 85) return `${unit} muito assertiv${unit === 'Mês' ? 'o' : 'a'}`
  if (score >= 70) return `${unit === 'Mês' ? 'Bom' : 'Boa'} ${unit.toLowerCase()}`
  if (score >= 50) return `${unit} irregular`
  return `${unit} fora do plano`
}

export function weightPoints(data: AppData, from: string, to: string): WeightPoint[] {
  return (data.body ?? [])
    .filter((b) => b.weight_kg != null && b.date >= from && b.date <= to)
    .map((b) => ({ date: b.date, kg: b.weight_kg as number }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Variações do peso no período: fim de semana (sexta → segunda seguinte)
 * e dias úteis (segunda → sexta da mesma semana).
 */
export function weightChanges(data: AppData, from: string, to: string): WeightChange[] {
  const byDate = new Map((data.body ?? []).filter((b) => b.weight_kg != null).map((b) => [b.date, b.weight_kg as number]))
  const out: WeightChange[] = []
  for (const p of weightPoints(data, from, to)) {
    const wd = weekdayOf(p.date)
    if (wd === 1) {
      const fri = addDays(p.date, -3)
      if (byDate.has(fri)) {
        const f = { date: fri, kg: byDate.get(fri)! }
        out.push({ label: 'Fim de semana', from: f, to: p, delta: Math.round((p.kg - f.kg) * 10) / 10 })
      }
    }
    if (wd === 5) {
      const mon = addDays(p.date, -4)
      if (byDate.has(mon)) {
        const m = { date: mon, kg: byDate.get(mon)! }
        out.push({ label: 'Segunda a sexta', from: m, to: p, delta: Math.round((p.kg - m.kg) * 10) / 10 })
      }
    }
  }
  return out
}

export function review(from: string, to: string, data: AppData, today: string, unit: 'Semana' | 'Mês' | 'Período' = 'Semana'): Review {
  const s = summarize(from, to, data, today)
  const daily = s.daily
  const days = daily.length
  const end = to < today ? to : today
  const views = days ? daily.map((d) => expandDay(d.date, data)) : []

  const waterDays = daily.filter((d) => d.waterOk).length
  const pillars: Pillar[] = [
    { key: 'kcal', label: 'Calorias na meta', done: s.daysInGoal, total: days, pct: pct(s.daysInGoal, days) },
    { key: 'meals', label: 'Refeições feitas', done: s.mealsDone, total: s.mealsTotal, pct: pct(s.mealsDone, s.mealsTotal) },
    { key: 'workouts', label: 'Treinos feitos', done: s.workoutsPlannedDone, total: s.workoutsPlanned, pct: pct(s.workoutsPlannedDone, s.workoutsPlanned) },
    { key: 'water', label: 'Dias com a meta de água', done: waterDays, total: days, pct: pct(waterDays, days) },
  ]
  const scored = pillars.filter((p) => p.total > 0)
  const anyRecord = daily.some((d) => d.hasRecord || d.workoutsDone > 0 || d.waterMl > 0)
  const score = scored.length && anyRecord ? Math.round(scored.reduce((a, p) => a + p.pct, 0) / scored.length) : null

  const above = daily.filter((d) => d.status === 'acima')
  const below = daily.filter((d) => d.status === 'abaixo')
  const empty = daily.filter((d) => d.status === 'vazio')
  const extras = views.flatMap((v) => v.extras)
  const extrasKcal = extras.reduce((a, e) => a + e.kcal, 0)
  const alcoholKcal = extras.filter((e) => e.category === 'alcool').reduce((a, e) => a + e.kcal, 0)
  const aboveSet = new Set(above.map((d) => d.date))
  const extrasOnAbove = extras.filter((e) => aboveSet.has(e.date)).reduce((a, e) => a + e.kcal, 0)
  const avgWaterMl = days ? Math.round(daily.reduce((a, d) => a + d.waterMl, 0) / days) : 0
  const goal = data.settings.calorie_goal

  const wins: string[] = []
  const misses: string[] = []

  // Calorias
  if (days) {
    if (s.daysInGoal === days) wins.push(`Todos os ${days} dias dentro da meta de calorias.`)
    else if (s.daysInGoal > 0) wins.push(`${s.daysInGoal} de ${days} dias dentro da meta de calorias.`)
    if (above.length) {
      misses.push(`Acima da meta em ${above.length} dia(s): ${listDays(above.map((d) => d.date))}.${extrasOnAbove ? ` Os extras desses dias somaram ${n(extrasOnAbove)} kcal.` : ''}`)
    }
    if (below.length) misses.push(`Abaixo da meta em ${below.length} dia(s): ${listDays(below.map((d) => d.date))}.`)
    if (empty.length) misses.push(`Sem nenhum registro de comida em ${empty.length} dia(s): ${listDays(empty.map((d) => d.date))}.`)
  }

  // Refeições: qual mais ficou sem check
  const missedByMeal = new Map<string, number>()
  for (const v of views) {
    if (v.stats.status === 'vazio') continue // dia sem registro já foi apontado acima
    for (const m of v.meals) if (m.plan && !m.log?.done) missedByMeal.set(m.name, (missedByMeal.get(m.name) ?? 0) + 1)
  }
  const worstMeals = [...missedByMeal.entries()].sort((a, b) => b[1] - a[1]).filter(([, c]) => c >= 2)
  if (s.mealsTotal && s.mealsDone === s.mealsTotal) wins.push('Todas as refeições do plano feitas.')
  for (const [name, c] of worstMeals.slice(0, 2)) misses.push(`${name} ficou sem check em ${c} dia(s).`)

  // Treinos
  const missedWorkouts = views.flatMap((v) =>
    v.date <= end ? v.workouts.filter((w) => w.plan && !w.log?.done).map((w) => `${w.plan!.name} (${dayName(v.date)})`) : [],
  )
  if (s.workoutsPlanned && !missedWorkouts.length) wins.push(`Todos os ${s.workoutsPlanned} treinos previstos feitos.`)
  else if (s.workoutsPlannedDone) wins.push(`${s.workoutsPlannedDone} de ${s.workoutsPlanned} treinos previstos feitos.`)
  if (missedWorkouts.length) {
    const shown = missedWorkouts.slice(0, 4).join(', ')
    misses.push(`Treinos não feitos: ${shown}${missedWorkouts.length > 4 ? ` e mais ${missedWorkouts.length - 4}` : ''}.`)
  }

  // Água
  if (days) {
    const goalL = liters(data.settings.water_goal_ml ?? 5000)
    if (waterDays === days) wins.push(`Meta de água (${goalL} L) batida todos os dias.`)
    else if (waterDays > 0) wins.push(`Meta de água batida em ${waterDays} de ${days} dias.`)
    if (waterDays < days) misses.push(`Água abaixo de ${goalL} L em ${days - waterDays} dia(s) (média ${liters(avgWaterMl)} L/dia).`)
  }

  // Extras
  if (extrasKcal) {
    misses.push(`Extras fora do plano: ${n(extrasKcal)} kcal${alcoholKcal ? `, sendo ${n(alcoholKcal)} kcal de álcool` : ''}.`)
  } else if (days) wins.push('Nenhum extra fora do plano.')

  // Peso
  const weights = weightPoints(data, from, end)
  const changes = weightChanges(data, from, end)
  const weightDelta = weights.length >= 2 ? Math.round((weights[weights.length - 1].kg - weights[0].kg) * 10) / 10 : null
  for (const c of changes) {
    const line = `${c.label}: ${signedKg(c.delta)} (${dayName(c.from.date)} ${kg(c.from.kg)} → ${dayName(c.to.date)} ${kg(c.to.kg)}).`
    if (c.label === 'Fim de semana' && c.delta >= 0.5) misses.push(line)
    else if (c.delta <= 0) wins.push(line)
    else misses.push(line)
  }

  return {
    from,
    to,
    days,
    score,
    verdict: verdictFor(score, unit),
    pillars,
    avgKcalIn: s.avgKcalIn,
    goal,
    daysAbove: above.length,
    daysBelow: below.length,
    extrasKcal,
    alcoholKcal,
    avgWaterMl,
    weights,
    weightDelta,
    weightChanges: changes,
    wins,
    misses,
    daily,
  }
}

export interface WeekPoint {
  weekStart: string
  score: number | null
  daysInGoal: number
  days: number
  avgKcalIn: number
  pctMeals: number
  pctWorkouts: number
  waterDays: number
  weightKg: number | null
}

/** Uma linha por semana (segunda a domingo) entre `from` e hoje: para os gráficos do mês e do acumulado. */
export function weeklySeries(from: string, to: string, data: AppData, today: string): WeekPoint[] {
  const out: WeekPoint[] = []
  const end = to < today ? to : today
  for (let ws = weekStart(from); ws <= end; ws = addDays(ws, 7)) {
    const r = review(ws, addDays(ws, 6), data, today)
    out.push({
      weekStart: ws,
      score: r.score,
      daysInGoal: r.pillars[0].done,
      days: r.days,
      avgKcalIn: r.avgKcalIn,
      pctMeals: r.pillars[1].pct,
      pctWorkouts: r.pillars[2].pct,
      waterDays: r.pillars[3].done,
      weightKg: r.weights.length ? r.weights[r.weights.length - 1].kg : null,
    })
  }
  return out
}

/** Texto curto do fechamento (usado pelo conector do Claude). */
export function reviewText(r: Review, title: string): string {
  const lines = [
    `${title}: ${r.score == null ? 'sem dados' : `assertividade ${r.score}%`} · ${r.verdict}.`,
    r.pillars.filter((p) => p.total).map((p) => `${p.label}: ${p.done}/${p.total} (${p.pct}%)`).join(' · '),
    `Média ingerida ${n(r.avgKcalIn)} kcal/dia (meta ${n(r.goal)}).${r.weightDelta != null ? ` Peso no período: ${signedKg(r.weightDelta)}.` : ''}`,
  ]
  if (r.wins.length) lines.push(`Funcionou: ${r.wins.join(' ')}`)
  if (r.misses.length) lines.push(`Falhou: ${r.misses.join(' ')}`)
  return lines.join('\n')
}

export interface WeeklyWeight {
  weekStart: string
  avg: number
  count: number
  /** Variação da média em relação à semana anterior com peso registrado. */
  delta: number | null
}

/** Média do peso por semana (segunda a domingo) e variação contra a semana anterior. */
export function weeklyWeightAverages(data: AppData, from: string, to: string): WeeklyWeight[] {
  const groups = new Map<string, number[]>()
  for (const p of weightPoints(data, from, to)) {
    const ws = weekStart(p.date)
    groups.set(ws, [...(groups.get(ws) ?? []), p.kg])
  }
  const out: WeeklyWeight[] = []
  for (const ws of [...groups.keys()].sort()) {
    const arr = groups.get(ws)!
    const avg = Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10
    const prev = out[out.length - 1]
    out.push({ weekStart: ws, avg, count: arr.length, delta: prev ? Math.round((avg - prev.avg) * 10) / 10 : null })
  }
  return out
}
