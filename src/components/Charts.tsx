// Gráficos simples em SVG/CSS, desenhados na mesma escala dos rótulos.
import type { DayStats } from '../../shared/calc.ts'
import { formatShort, WEEKDAY_SHORT, weekdayOf } from '../../shared/dates.ts'
import type { WeekPoint, WeightPoint } from '../../shared/review.ts'
import type { BalanceDay } from '../../shared/balance.ts'
import { fmt, formatKg } from '../lib/format.ts'

/** Kcal por dia com a faixa da meta, e a água do dia logo abaixo. */
export function DailyChart({ days }: { days: DayStats[] }) {
  if (!days.length) return null
  const max = Math.max(days[0].max * 1.15, ...days.map((d) => d.kcalIn))
  const h = (n: number) => `${(n / max) * 100}%`
  const many = days.length > 10
  return (
    <div className="card chart">
      <div className="chart-head">
        <b>Calorias por dia</b>
        <span className="legend">
          <i className="dot dentro" /> na meta <i className="dot fora" /> fora <i className="dot vazio" /> sem registro
        </span>
      </div>
      <div className="chart-area" role="img" aria-label="Calorias ingeridas por dia, com a faixa da meta">
        <div className="band" style={{ bottom: h(days[0].min), height: `calc(${h(days[0].max)} - ${h(days[0].min)})` }} />
        <span className="band-label">meta {fmt(days[0].goal)}</span>
        {days.map((d) => (
          <div key={d.date} className="col" title={`${formatShort(d.date)}: ${fmt(d.kcalIn)} kcal`}>
            {!many && d.hasRecord && <span className="col-val">{(d.kcalIn / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k</span>}
            <div className={`colbar ${d.status === 'dentro' ? 'dentro' : d.status === 'vazio' ? 'vazio' : 'fora'}`} style={{ height: d.hasRecord ? h(d.kcalIn) : '2px' }} />
          </div>
        ))}
      </div>
      <div className="water-row" aria-label="Meta de água por dia">
        {days.map((d) => (
          <span key={d.date} className={`drop ${d.waterOk ? 'ok' : d.waterMl > 0 ? 'part' : ''}`} title={`${formatShort(d.date)}: ${(d.waterMl / 1000).toLocaleString('pt-BR')} L`} />
        ))}
      </div>
      <div className="chart-axis">
        {days.map((d, i) => (
          <span key={d.date}>{!many ? WEEKDAY_SHORT[weekdayOf(d.date)] : i % 5 === 0 ? d.date.slice(8) : ''}</span>
        ))}
      </div>
      <p className="muted small">Gotas: água do dia (cheia = meta batida).</p>
    </div>
  )
}

/** Nota de assertividade por semana. */
export function WeekBars({ weeks, title }: { weeks: WeekPoint[]; title: string }) {
  if (!weeks.length) return null
  return (
    <div className="card chart">
      <div className="chart-head">
        <b>{title}</b>
        <span className="legend">assertividade por semana (%)</span>
      </div>
      <div className="weeks-scroll">
        <div className="weeks" style={{ minWidth: `${Math.max(weeks.length * 44, 200)}px` }}>
          {weeks.map((w) => (
            <div key={w.weekStart} className="week" title={`Semana de ${formatShort(w.weekStart)}: ${w.score ?? '–'}%`}>
              <span className="col-val">{w.score ?? '–'}</span>
              <div className="week-track">
                <div className={`colbar ${w.score == null ? 'vazio' : w.score >= 70 ? 'dentro' : 'fora'}`} style={{ height: `${w.score ?? 2}%` }} />
              </div>
              <span className="week-label">{formatShort(w.weekStart)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Linha do peso com pontos (segunda e sexta). */
export function WeightChart({ points }: { points: WeightPoint[] }) {
  if (points.length === 0) return <p className="empty">Nenhum peso registrado ainda. Registre na segunda e na sexta, na tela Hoje.</p>
  const W = 320
  const H = 150
  const pad = { l: 34, r: 10, t: 14, b: 22 }
  const kgs = points.map((p) => p.kg)
  let lo = Math.min(...kgs)
  let hi = Math.max(...kgs)
  if (hi - lo < 2) {
    const mid = (hi + lo) / 2
    lo = mid - 1
    hi = mid + 1
  }
  lo = Math.floor(lo * 2) / 2
  hi = Math.ceil(hi * 2) / 2
  const x = (i: number) => pad.l + (points.length === 1 ? (W - pad.l - pad.r) / 2 : (i / (points.length - 1)) * (W - pad.l - pad.r))
  const y = (v: number) => pad.t + ((hi - v) / (hi - lo)) * (H - pad.t - pad.b)
  const ticks = [lo, (lo + hi) / 2, hi]
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.kg).toFixed(1)}`).join(' ')
  const last = points[points.length - 1]
  return (
    <svg className="weight-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Peso: de ${formatKg(points[0].kg)} a ${formatKg(last.kg)} kg`}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
          <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="tick">{formatKg(t)}</text>
        </g>
      ))}
      <path d={path} className="wline" fill="none" />
      {points.map((p, i) => (
        <circle key={p.date} cx={x(i)} cy={y(p.kg)} r={i === points.length - 1 ? 4.5 : 3} className={i === points.length - 1 ? 'wdot last' : 'wdot'}>
          <title>{`${formatShort(p.date)}: ${formatKg(p.kg)} kg`}</title>
        </circle>
      ))}
      <text x={pad.l} y={H - 6} className="tick">{formatShort(points[0].date)}</text>
      {points.length > 1 && <text x={W - pad.r} y={H - 6} textAnchor="end" className="tick">{formatShort(last.date)}</text>}
    </svg>
  )
}

/**
 * Saldo diário em barras a partir do zero: para cima = superávit (vermelho), para baixo = déficit (verde).
 * Dia sem registro de comida = marca cinza no zero. Dia em andamento = barra tracejada com a projeção.
 */
export function BalanceChart({ days }: { days: BalanceDay[] }) {
  if (!days.length) return null
  const vals = days.flatMap((d) => [d.balance ?? 0, d.projection?.balance ?? 0])
  const lim = Math.max(500, ...vals.map((v) => Math.abs(v)))
  const top = Math.ceil(lim / 500) * 500
  const h = (v: number) => `${(Math.abs(v) / top) * 50}%`
  const many = days.length > 10
  return (
    <div className="card chart">
      <div className="chart-head">
        <b>Saldo por dia</b>
        <span className="legend">
          <i className="dot deficit" /> déficit <i className="dot surplus" /> superávit <i className="dot vazio" /> sem registro
        </span>
      </div>
      <div className="balance-area" role="img" aria-label="Saldo calórico por dia">
        <span className="axis-label top">+{fmt(top)}</span>
        <span className="axis-label mid">0</span>
        <span className="axis-label bottom">−{fmt(top)}</span>
        <div className="zero-line" />
        {days.map((d) => {
          const v = d.inProgress ? (d.projection?.balance ?? d.balance) : d.balance
          const cls = v == null ? 'none' : v < 0 ? 'deficit' : 'surplus'
          return (
            <div key={d.date} className="bcol" title={`${formatShort(d.date)}: ${v == null ? 'sem registro' : `${v > 0 ? '+' : ''}${fmt(v)} kcal`}${d.inProgress ? ' (projeção)' : ''}`}>
              {v != null && (
                <div className={`bbar ${cls} ${d.inProgress ? 'proj' : ''}`} style={v < 0 ? { top: '50%', height: h(v) } : { bottom: '50%', height: h(v) }} />
              )}
              {v == null && <div className="bnone" />}
            </div>
          )
        })}
      </div>
      <div className="chart-axis">
        {days.map((d, i) => (
          <span key={d.date} className={d.inProgress ? 'now' : ''}>{!many ? WEEKDAY_SHORT[weekdayOf(d.date)] : i % 5 === 0 ? d.date.slice(8) : ''}</span>
        ))}
      </div>
    </div>
  )
}
