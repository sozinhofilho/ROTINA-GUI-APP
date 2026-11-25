import { useEffect, useState } from 'react'
import { currentStreak, summarize, workoutStreak, type DayStats } from '../../shared/calc.ts'
import { addDays, formatShort, monthEnd, monthStart, todayISO, weekStart, WEEKDAY_SHORT, weekdayOf } from '../../shared/dates.ts'
import { Icon } from '../components/ui.tsx'
import { fmt } from '../lib/format.ts'
import { ensureRange, useStore } from '../lib/store.ts'

const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']

export function Summary() {
  const data = useStore((s) => s.view)
  const today = todayISO(data?.settings.timezone)
  const [mode, setMode] = useState<'semana' | 'mes'>('semana')
  const [anchor, setAnchor] = useState(today)

  const from = mode === 'semana' ? weekStart(anchor) : monthStart(anchor)
  const to = mode === 'semana' ? addDays(from, 6) : monthEnd(anchor)
  const histFrom = addDays(today, -120) < from ? addDays(today, -120) : from

  useEffect(() => {
    void ensureRange(histFrom, to > today ? to : today, { photos: false, maxAgeMs: 30_000 })
  }, [histFrom, to, today])

  if (!data) return <div className="empty">Carregando…</div>
  const s = summarize(from, to, data, today)
  const streak = currentStreak(data, today, 120)
  const wStreak = workoutStreak(data, today, 120)
  const move = (dir: number) => setAnchor(mode === 'semana' ? addDays(anchor, 7 * dir) : addDays(monthStart(anchor), dir > 0 ? 32 : -1))
  const title = mode === 'semana' ? `${formatShort(from)} a ${formatShort(to)}` : `${MONTHS[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Resumo</h1>
      </header>
      <div className="chips">
        <button className={`chip ${mode === 'semana' ? 'on' : ''}`} onClick={() => setMode('semana')}>Semana</button>
        <button className={`chip ${mode === 'mes' ? 'on' : ''}`} onClick={() => setMode('mes')}>Mês</button>
      </div>
      <div className="day-head">
        <button className="icon-btn big" onClick={() => move(-1)} aria-label="Período anterior"><Icon name="left" /></button>
        <div className="day-title"><h2>{title}</h2>
          {(from > today || to < today) && <button className="link" onClick={() => setAnchor(today)}>período atual</button>}
        </div>
        <button className="icon-btn big" onClick={() => move(1)} aria-label="Próximo período"><Icon name="right" /></button>
      </div>

      <div className="kpis">
        <Kpi label="Dias na meta" value={`${s.daysInGoal}/${s.days}`} sub={s.daysWithRecord < s.days ? `${s.daysWithRecord} com registro` : undefined} />
        <Kpi label="Média ingerida" value={fmt(s.avgKcalIn)} sub={`kcal/dia · meta ${fmt(data.settings.calorie_goal)}`} />
        <Kpi label={s.hasBase ? 'Média de gasto' : 'Média gasto treinos'} value={fmt(s.avgSpent)} sub="kcal/dia" />
        <Kpi label="Refeições feitas" value={`${s.pctMeals}%`} sub={`${s.mealsDone}/${s.mealsTotal}`} />
        <Kpi label="Treinos feitos" value={`${s.pctWorkouts}%`} sub={`${s.workoutsPlannedDone}/${s.workoutsPlanned} previstos · ${s.workoutsDone} no total`} />
        <Kpi label="Sequência na meta" value={`${streak} ${streak === 1 ? 'dia' : 'dias'}`} sub={`melhor no período: ${s.bestStreak}`} />
        <Kpi label="Sequência de treinos" value={`${wStreak} ${wStreak === 1 ? 'dia' : 'dias'}`} sub="dias seguidos com treino feito" />
      </div>

      {s.daily.length > 0 && <DailyChart days={s.daily} />}
      {s.days === 0 && <p className="empty">Período ainda não começou.</p>}
    </div>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card kpi">
      <span className="muted small">{label}</span>
      <b className="kpi-value">{value}</b>
      {sub && <span className="muted small">{sub}</span>}
    </div>
  )
}

function DailyChart({ days }: { days: DayStats[] }) {
  const goal = days[0].goal
  const max = Math.max(goal * 1.3, ...days.map((d) => d.kcalIn))
  const h = (n: number) => `${(n / max) * 100}%`
  return (
    <div className="card chart">
      <div className="chart-head">
        <b>Kcal por dia</b>
        <span className="legend"><i className="dot dentro" /> na meta <i className="dot fora" /> fora <i className="dot vazio" /> sem registro</span>
      </div>
      <div className="chart-area" role="img" aria-label="Calorias ingeridas por dia">
        <div className="band" style={{ bottom: h(days[0].min), height: `calc(${h(days[0].max)} - ${h(days[0].min)})` }} />
        {days.map((d) => (
          <div key={d.date} className="col" title={`${formatShort(d.date)}: ${fmt(d.kcalIn)} kcal`}>
            <div className={`colbar ${d.status === 'dentro' ? 'dentro' : d.status === 'vazio' ? 'vazio' : 'fora'}`} style={{ height: d.hasRecord ? h(d.kcalIn) : '2px' }} />
          </div>
        ))}
      </div>
      <div className="chart-axis">
        {days.map((d, i) => (
          <span key={d.date}>{days.length <= 7 ? WEEKDAY_SHORT[weekdayOf(d.date)] : i % 5 === 0 ? d.date.slice(8) : ''}</span>
        ))}
      </div>
    </div>
  )
}
