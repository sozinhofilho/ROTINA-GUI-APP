import { useEffect, useState } from 'react'
import { addDays, formatBR, formatShort, monthEnd, monthStart, todayISO, WEEKDAY_SHORT, weekdayOf, weekStart } from '../../shared/dates.ts'
import { review, weeklySeries, type Review } from '../../shared/review.ts'
import { DailyChart, WeekBars, WeightChart } from '../components/Charts.tsx'
import { Icon } from '../components/ui.tsx'
import { fmt, formatKg } from '../lib/format.ts'
import { ensureRange, useStore } from '../lib/store.ts'

const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
type Mode = 'semana' | 'mes' | 'acumulado'

const signedKg = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${formatKg(Math.abs(v))} kg`

export function Summary() {
  const data = useStore((s) => s.view)
  const firstDate = useStore((s) => s.firstDate)
  const today = todayISO(data?.settings.timezone)
  const [mode, setMode] = useState<Mode>('semana')
  const [anchor, setAnchor] = useState(today)

  const allFrom = firstDate && firstDate < today ? weekStart(firstDate) : weekStart(addDays(today, -27))
  const from = mode === 'semana' ? weekStart(anchor) : mode === 'mes' ? monthStart(anchor) : allFrom
  const to = mode === 'semana' ? addDays(from, 6) : mode === 'mes' ? monthEnd(anchor) : today
  const loadFrom = from < addDays(today, -60) ? from : addDays(today, -60)

  useEffect(() => {
    void ensureRange(loadFrom, to > today ? to : today, { photos: false, maxAgeMs: 30_000 })
  }, [loadFrom, to, today])

  if (!data) return <div className="empty">Carregando…</div>
  const unit = mode === 'semana' ? 'Semana' : mode === 'mes' ? 'Mês' : 'Período'
  const r = review(from, to, data, today, unit)
  const weeks = mode === 'semana' ? [] : weeklySeries(from, to, data, today)
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
        <h1>Fechamento</h1>
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
            {isCurrent ? <span className="muted small">em andamento · conta até hoje</span> : <button className="link" onClick={() => setAnchor(today)}>voltar ao atual</button>}
          </div>
          <button className="icon-btn big" onClick={() => move(1)} aria-label="Próximo período"><Icon name="right" /></button>
        </div>
      ) : (
        <p className="muted small">{title} · {r.days} dias · {weeks.length} semana(s)</p>
      )}

      {r.days === 0 ? (
        <p className="empty">Este período ainda não começou.</p>
      ) : (
        <>
          <ScoreCard r={r} />
          {mode !== 'semana' && <WeekBars weeks={weeks} title={mode === 'mes' ? 'Semanas do mês' : 'Todas as semanas'} />}
          {mode !== 'acumulado' && <DailyChart days={r.daily} />}
          <Findings r={r} />
          <WeightCard r={r} mode={mode} />
          <Numbers r={r} />
        </>
      )}
    </div>
  )
}

function ScoreCard({ r }: { r: Review }) {
  const tone = r.score == null ? 'vazio' : r.score >= 85 ? 'dentro' : r.score >= 70 ? 'bom' : r.score >= 50 ? 'abaixo' : 'acima'
  return (
    <div className={`card score ${tone}`}>
      <div className="score-top">
        <div className="score-ring" style={{ ['--p' as string]: `${r.score ?? 0}` }} role="img" aria-label={`Assertividade ${r.score ?? 0}%`}>
          <b>{r.score ?? '–'}</b>
          <span>%</span>
        </div>
        <div>
          <span className="muted small">Assertividade</span>
          <h2>{r.verdict}</h2>
          <span className="muted small">média dos 4 pilares abaixo</span>
        </div>
      </div>
      <div className="pillars">
        {r.pillars.map((p) => (
          <div key={p.key} className="pillar">
            <div className="pillar-head">
              <span>{p.label}</span>
              <b>{p.total ? `${p.done}/${p.total}` : '—'}</b>
            </div>
            <div className="bar slim">
              <div className={`bar-fill ${p.pct >= 85 ? 'good' : p.pct >= 60 ? 'mid' : 'low'}`} style={{ width: `${p.total ? p.pct : 0}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Findings({ r }: { r: Review }) {
  return (
    <div className="findings">
      <div className="card find good">
        <b>O que funcionou</b>
        {r.wins.length ? (
          <ul>{r.wins.map((w) => <li key={w}>{w}</li>)}</ul>
        ) : (
          <p className="muted small">Nada para destacar ainda.</p>
        )}
      </div>
      <div className="card find bad">
        <b>Onde falhou</b>
        {r.misses.length ? (
          <ul>{r.misses.map((w) => <li key={w}>{w}</li>)}</ul>
        ) : (
          <p className="muted small">Nenhuma falha no período.</p>
        )}
      </div>
    </div>
  )
}

function WeightCard({ r, mode }: { r: Review; mode: Mode }) {
  return (
    <div className="card">
      <div className="chart-head">
        <b>Peso</b>
        {r.weightDelta != null && <span className={`badge ${r.weightDelta <= 0 ? 'dentro' : 'acima'}`}>{signedKg(r.weightDelta)} no período</span>}
      </div>
      {mode === 'semana' ? (
        r.weights.length ? (
          <ul className="weights">
            {r.weights.map((w) => (
              <li key={w.date}><span>{WEEKDAY_SHORT[weekdayOf(w.date)]} {formatShort(w.date)}</span><b>{formatKg(w.kg)} kg</b></li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Sem peso registrado nesta semana (segunda e sexta).</p>
        )
      ) : (
        <WeightChart points={r.weights} />
      )}
      {r.weightChanges.length > 0 && (
        <ul className="weights changes">
          {r.weightChanges.slice(-6).map((c) => (
            <li key={c.to.date + c.label}>
              <span>{c.label} ({formatShort(c.from.date)} → {formatShort(c.to.date)})</span>
              <b className={c.delta > 0 ? 'up' : 'down'}>{signedKg(c.delta)}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Numbers({ r }: { r: Review }) {
  return (
    <div className="kpis">
      <div className="card kpi"><span className="muted small">Média ingerida</span><b className="kpi-value">{fmt(r.avgKcalIn)}</b><span className="muted small">kcal/dia · meta {fmt(r.goal)}</span></div>
      <div className="card kpi"><span className="muted small">Dias acima / abaixo</span><b className="kpi-value">{r.daysAbove} / {r.daysBelow}</b><span className="muted small">da faixa da meta</span></div>
      <div className="card kpi"><span className="muted small">Extras</span><b className="kpi-value">{fmt(r.extrasKcal)}</b><span className="muted small">kcal{r.alcoholKcal ? ` · ${fmt(r.alcoholKcal)} de álcool` : ''}</span></div>
      <div className="card kpi"><span className="muted small">Água média</span><b className="kpi-value">{(r.avgWaterMl / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} L</b><span className="muted small">por dia</span></div>
    </div>
  )
}
