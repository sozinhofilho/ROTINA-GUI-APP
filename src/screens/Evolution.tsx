import { useEffect, useState } from 'react'
import { energyBalance, KCAL_PER_KG_FAT, previousPeriod, type BalanceSummary } from '../../shared/balance.ts'
import { addDays, formatBR, formatShort, monthEnd, monthStart, todayISO, WEEKDAY_SHORT, weekdayOf, weekStart } from '../../shared/dates.ts'
import { BalanceChart } from '../components/Charts.tsx'
import { Icon } from '../components/ui.tsx'
import { fmt } from '../lib/format.ts'
import { ensureRange, useStore } from '../lib/store.ts'

const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
type Mode = 'semana' | 'mes' | 'acumulado'

const sign = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v))}`
const tone = (v: number | null | undefined) => (v == null ? '' : v < 0 ? 'deficit' : v > 0 ? 'surplus' : '')
const kg = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg`

/** Aba "Evolução": saldo calórico (consumido − gasto basal − treinos) por semana, mês e acumulado. */
export function Evolution({ goTo }: { goTo: (tab: 'plano') => void }) {
  const data = useStore((s) => s.view)
  const firstDate = useStore((s) => s.firstDate)
  const today = todayISO(data?.settings.timezone)
  const [mode, setMode] = useState<Mode>('semana')
  const [anchor, setAnchor] = useState(today)

  const allFrom = firstDate && firstDate < today ? firstDate : addDays(today, -27)
  const from = mode === 'semana' ? weekStart(anchor) : mode === 'mes' ? monthStart(anchor) : allFrom
  const to = mode === 'semana' ? addDays(from, 6) : mode === 'mes' ? monthEnd(anchor) : today
  const prevRange = mode === 'acumulado' ? null : previousPeriod(mode, from)
  const loadFrom = prevRange && prevRange.from < from ? prevRange.from : from

  useEffect(() => {
    void ensureRange(loadFrom, to > today ? to : today, { photos: false, maxAgeMs: 30_000 })
  }, [loadFrom, to, today])

  if (!data) return <div className="empty">Carregando…</div>
  const b = energyBalance(from, to, data, today)
  const prev = prevRange ? energyBalance(prevRange.from, prevRange.to, data, today) : null
  const move = (dir: number) => setAnchor(mode === 'semana' ? addDays(anchor, 7 * dir) : addDays(monthStart(anchor), dir > 0 ? 32 : -1))
  const title =
    mode === 'semana'
      ? `${WEEKDAY_SHORT[weekdayOf(from)]} ${formatShort(from)} a ${WEEKDAY_SHORT[weekdayOf(to)]} ${formatShort(to)}`
      : mode === 'mes'
        ? `${MONTHS[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`
        : `Desde ${formatBR(from)}`
  const isCurrent = from <= today && to >= today

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Evolução</h1>
        <p className="muted small">Saldo = consumido − (gasto basal + treinos). Negativo é déficit.</p>
      </header>
      <div className="chips" role="tablist">
        {(['semana', 'mes', 'acumulado'] as Mode[]).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} className={`chip ${mode === m ? 'on' : ''}`} onClick={() => { setMode(m); setAnchor(today) }}>
            {m === 'semana' ? 'Semana' : m === 'mes' ? 'Mês' : 'Acumulado'}
          </button>
        ))}
      </div>
      {mode !== 'acumulado' ? (
        <div className="day-head">
          <button className="icon-btn big" onClick={() => move(-1)} aria-label="Período anterior"><Icon name="left" /></button>
          <div className="day-title">
            <h2>{title}</h2>
            {isCurrent ? <span className="muted small">em andamento · hoje fica fora das médias</span> : <button className="link" onClick={() => setAnchor(today)}>voltar ao atual</button>}
          </div>
          <button className="icon-btn big" onClick={() => move(1)} aria-label="Próximo período"><Icon name="right" /></button>
        </div>
      ) : (
        <p className="muted small">{title}</p>
      )}

      {b.base == null ? (
        <div className="card warn-card">
          <b>Defina o gasto basal em Ajustes</b>
          <p className="muted small">Sem ele não dá para calcular o gasto total nem o saldo.</p>
          <button className="btn" onClick={() => goTo('plano')}>Abrir Ajustes</button>
        </div>
      ) : (
        <>
          <Headline b={b} />
          {prev && <Compare b={b} prev={prev} label={mode === 'semana' ? 'Semana anterior' : 'Mês anterior'} />}
          {b.today && <TodayCard b={b} />}
          <BalanceChart days={b.daily} />
          <Numbers b={b} />
          <Workouts b={b} />
        </>
      )}
    </div>
  )
}

function Headline({ b }: { b: BalanceSummary }) {
  if (!b.daysWithFood) {
    return (
      <div className="card">
        <b>Saldo acumulado</b>
        <p className="muted small">Nenhum dia encerrado com registro de comida neste período{b.daysWithoutFood ? ` (${b.daysWithoutFood} dia(s) sem registro)` : ''}.</p>
      </div>
    )
  }
  return (
    <div className={`card headline ${tone(b.totalBalance)}`}>
      <span className="muted small">Saldo acumulado · {b.daysWithFood} dia(s) com registro</span>
      <b className="headline-num">{sign(b.totalBalance!)} <small>kcal</small></b>
      <span>
        ≈ <b>{kg(b.fatKg!)}</b> de gordura <span className="muted small">(estimativa: saldo ÷ {fmt(KCAL_PER_KG_FAT)})</span>
      </span>
      <div className="headline-row">
        <span>Média <b className={tone(b.avgBalance)}>{sign(b.avgBalance!)}</b>/dia</span>
        <span><b className="deficit">{b.deficitDays}</b> em déficit</span>
        <span><b className="surplus">{b.surplusDays}</b> em superávit</span>
      </div>
      {b.daysWithoutFood > 0 && <span className="muted small">{b.daysWithoutFood} dia(s) sem registro, fora das médias.</span>}
    </div>
  )
}

function Compare({ b, prev, label }: { b: BalanceSummary; prev: BalanceSummary; label: string }) {
  if (prev.avgBalance == null) return <p className="muted small">{label}: sem dias com registro para comparar.</p>
  const rows: [string, number | null, number | null, boolean][] = [
    ['Saldo médio/dia', prev.avgBalance, b.avgBalance, true],
    ['Consumo médio', prev.avgKcalIn, b.avgKcalIn, true],
    ['Gasto total médio', prev.avgSpent, b.avgSpent, false],
    ['Treino/dia', prev.workoutKcalAvgPerDay, b.workoutKcalAvgPerDay, false],
  ]
  return (
    <div className="card">
      <b>Comparação com {label.toLowerCase()}</b>
      <ul className="weights">
        {rows.map(([name, a, c, lowerIsBetter]) => {
          const better = a != null && c != null ? (lowerIsBetter ? c < a : c > a) : null
          return (
            <li key={name}>
              <span>{name}</span>
              <span className="muted small">{a != null ? fmt(a) : '—'} → </span>
              <b className={better == null || a === c ? '' : better ? 'down' : 'up'}>{c != null ? fmt(c) : '—'}</b>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function TodayCard({ b }: { b: BalanceSummary }) {
  const t = b.today!
  return (
    <div className="card today-card">
      <div className="chart-head">
        <b>Hoje</b>
        <span className="badge">em andamento</span>
      </div>
      <p className="small">
        Consumido {fmt(t.kcalIn)} · gasto {fmt(t.spent!)} · saldo{' '}
        <b className={tone(t.balance)}>{t.balance != null ? sign(t.balance) : 'sem registro de comida'}</b>
      </p>
      {t.projection && t.projection.remainingMeals.length > 0 && t.projection.balance != null && (
        <p className="small projection">
          Projeção fazendo {t.projection.remainingMeals.join(', ')} como no plano: <b className={tone(t.projection.balance)}>{sign(t.projection.balance)}</b> kcal.
        </p>
      )}
      {t.pendingWorkouts.length > 0 && <p className="muted small">Treino pendente hoje: {t.pendingWorkouts.join(', ')}.</p>}
    </div>
  )
}

function Numbers({ b }: { b: BalanceSummary }) {
  return (
    <div className="kpis">
      <div className="card kpi"><span className="muted small">Consumo médio</span><b className="kpi-value">{b.avgKcalIn != null ? fmt(b.avgKcalIn) : '—'}</b><span className="muted small">kcal por dia registrado</span></div>
      <div className="card kpi"><span className="muted small">Gasto total médio</span><b className="kpi-value">{b.avgSpent != null ? fmt(b.avgSpent) : '—'}</b><span className="muted small">basal {fmt(b.base!)} + treino</span></div>
      <div className="card kpi"><span className="muted small">Kcal em treino</span><b className="kpi-value">{fmt(b.workoutKcalTotal)}</b><span className="muted small">{fmt(b.workoutKcalAvgPerDay)} por dia{b.workoutKcalEstimated ? ` · ${fmt(b.workoutKcalEstimated)} estimadas` : ''}</span></div>
      <div className="card kpi"><span className="muted small">Treinos feitos</span><b className="kpi-value">{b.workoutsDone}/{b.workoutsPlanned}</b><span className="muted small">previstos até ontem</span></div>
    </div>
  )
}

function Workouts({ b }: { b: BalanceSummary }) {
  if (!b.missedWorkouts.length && !b.workoutKcalEstimated) return null
  return (
    <div className="card find bad">
      {b.missedWorkouts.length > 0 && (
        <>
          <b>Treinos que faltaram</b>
          <ul>{b.missedWorkouts.map((m) => <li key={m.date + m.name}>{m.name} · {WEEKDAY_SHORT[weekdayOf(m.date)]} {formatShort(m.date)}</li>)}</ul>
        </>
      )}
      {b.workoutKcalEstimated > 0 && (
        <p className="muted small">{fmt(b.workoutKcalEstimated)} kcal de treino vieram da estimativa do plano (treinos sem kcal real). Registre a kcal do relógio para ficar exato.</p>
      )}
    </div>
  )
}
