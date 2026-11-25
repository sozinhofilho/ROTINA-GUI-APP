import { useEffect, useState } from 'react'
import { addDays, formatBR, formatShort, todayISO, WEEKDAY_SHORT, weekdayOf } from '../../shared/dates.ts'
import { weightChanges, weightPoints } from '../../shared/review.ts'
import type { BodyCheckin } from '../../shared/types.ts'
import { WeightChart } from '../components/Charts.tsx'
import { Field } from '../components/ui.tsx'
import { formatKg } from '../lib/format.ts'
import { ensureRange, useStore } from '../lib/store.ts'

const label = (b: BodyCheckin) => `${WEEKDAY_SHORT[weekdayOf(b.date)]} ${formatShort(b.date)}${b.weight_kg != null ? ` · ${formatKg(b.weight_kg)} kg` : ''}`
const signedKg = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${formatKg(Math.abs(v))} kg`

export function Progress() {
  const data = useStore((s) => s.view)
  const firstDate = useStore((s) => s.firstDate)
  const urls = useStore((s) => s.photoUrls)
  const today = todayISO(data?.settings.timezone)
  const from = firstDate && firstDate < addDays(today, -60) ? firstDate : addDays(today, -60)
  const [before, setBefore] = useState('')
  const [after, setAfter] = useState('')
  const [pose, setPose] = useState<'front' | 'side'>('front')

  useEffect(() => {
    void ensureRange(from, today, { maxAgeMs: 60_000 })
  }, [from, today])

  if (!data) return <div className="empty">Carregando…</div>
  const checkins = (data.body ?? []).filter((b) => b.date >= from && b.date <= today).sort((a, b) => a.date.localeCompare(b.date))
  const withPhotos = checkins.filter((b) => b.photo_front || b.photo_side)
  const points = weightPoints(data, from, today)
  const changes = weightChanges(data, from, today)
  const a = withPhotos.find((b) => b.date === before) ?? withPhotos[0]
  const b = withPhotos.find((x) => x.date === after) ?? withPhotos[withPhotos.length - 1]
  const total = points.length >= 2 ? Math.round((points[points.length - 1].kg - points[0].kg) * 10) / 10 : null
  const avgWeekend = (() => {
    const w = changes.filter((c) => c.label === 'Fim de semana')
    return w.length ? Math.round((w.reduce((s, c) => s + c.delta, 0) / w.length) * 10) / 10 : null
  })()

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Evolução</h1>
      </header>

      <div className="card">
        <div className="chart-head">
          <b>Peso</b>
          {total != null && <span className={`badge ${total <= 0 ? 'dentro' : 'acima'}`}>{signedKg(total)} desde {formatShort(points[0].date)}</span>}
        </div>
        <WeightChart points={points} />
        {avgWeekend != null && (
          <p className="muted small">Média do fim de semana (sexta → segunda): <b>{signedKg(avgWeekend)}</b> em {changes.filter((c) => c.label === 'Fim de semana').length} fim(ns) de semana.</p>
        )}
      </div>

      <section>
        <h2 className="section-title">Antes e depois</h2>
        {withPhotos.length === 0 ? (
          <p className="empty">Nenhuma foto ainda. Na segunda e na sexta, a tela Hoje mostra o cartão “Peso e fotos”.</p>
        ) : (
          <div className="card compare">
            <div className="grid2">
              <Field label="Antes">
                {(id) => (
                  <select id={id} value={a?.date ?? ''} onChange={(e) => setBefore(e.target.value)}>
                    {withPhotos.map((c) => <option key={c.date} value={c.date}>{label(c)}</option>)}
                  </select>
                )}
              </Field>
              <Field label="Depois">
                {(id) => (
                  <select id={id} value={b?.date ?? ''} onChange={(e) => setAfter(e.target.value)}>
                    {withPhotos.map((c) => <option key={c.date} value={c.date}>{label(c)}</option>)}
                  </select>
                )}
              </Field>
            </div>
            <div className="chips">
              <button className={`chip ${pose === 'front' ? 'on' : ''}`} onClick={() => setPose('front')}>Frente</button>
              <button className={`chip ${pose === 'side' ? 'on' : ''}`} onClick={() => setPose('side')}>Lado</button>
            </div>
            <div className="compare-grid">
              {[a, b].map((c, i) => {
                const path = c ? (pose === 'front' ? c.photo_front : c.photo_side) : null
                const url = path ? urls[path] : undefined
                return (
                  <figure key={i}>
                    <div className="compare-img">
                      {url ? <img src={url} alt={`${pose === 'front' ? 'Frente' : 'Lado'} em ${c ? formatBR(c.date) : ''}`} /> : <span className="muted small">{path ? 'carregando…' : 'sem foto'}</span>}
                    </div>
                    <figcaption>
                      <b>{i === 0 ? 'Antes' : 'Depois'}</b> · {c ? label(c) : '—'}
                    </figcaption>
                  </figure>
                )
              })}
            </div>
            {a?.weight_kg != null && b?.weight_kg != null && a.date !== b.date && (
              <p className="compare-delta">Diferença: <b>{signedKg(Math.round((b.weight_kg - a.weight_kg) * 10) / 10)}</b> em {Math.round((Date.parse(b.date) - Date.parse(a.date)) / 86_400_000)} dias</p>
            )}
          </div>
        )}
      </section>

      {checkins.length > 0 && (
        <section>
          <h2 className="section-title">Registros</h2>
          <ul className="card weights">
            {[...checkins].reverse().map((c) => (
              <li key={c.date}>
                <span>{WEEKDAY_SHORT[weekdayOf(c.date)]} {formatBR(c.date)}</span>
                <span className="muted small">{[c.photo_front && 'frente', c.photo_side && 'lado'].filter(Boolean).join(' + ') || 'sem foto'}</span>
                <b>{c.weight_kg != null ? `${formatKg(c.weight_kg)} kg` : '—'}</b>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
