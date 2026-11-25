import { useRef, useState } from 'react'
import { formatShort, WEEKDAY_LONG, weekdayOf } from '../../shared/dates.ts'
import { stableId } from '../../shared/ids.ts'
import type { BodyCheckin } from '../../shared/types.ts'
import { ApiError } from '../lib/api.ts'
import { formatKg, parseKg } from '../lib/format.ts'
import { uploadPhoto } from '../lib/photo.ts'
import { dispatch, setPhotoUrl, toast, useStore } from '../lib/store.ts'
import { Field, Icon, LazyInput } from './ui.tsx'

const L = (ml: number) => (ml / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })

export function WaterCard({ date, ml, goal }: { date: string; ml: number; goal: number }) {
  const set = (v: number) => dispatch({ t: 'water.set', row: { date, ml: Math.max(0, Math.min(20000, v)) } })
  const ok = ml >= goal
  const pct = goal ? Math.min(100, (ml / goal) * 100) : 0
  return (
    <section className={`card water ${ok ? 'ok' : ''}`} aria-label="Água do dia">
      <div className="water-top">
        <div>
          <span className="muted small">Água</span>
          <div>
            <b className="water-num">{L(ml)}</b> <span className="muted">/ {L(goal)} L</span>
          </div>
        </div>
        <span className={`badge ${ok ? 'dentro' : ''}`}>{ok ? '✓ Meta batida' : `faltam ${L(goal - ml)} L`}</span>
      </div>
      <div className="bar water-bar" role="img" aria-label={`${L(ml)} de ${L(goal)} litros`}>
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="water-btns">
        <button className="btn secondary" onClick={() => set(ml + 500)}>+ 500 ml</button>
        <button className="btn" onClick={() => set(ml + 1000)}>+ 1 L</button>
        <button className="icon-btn" onClick={() => set(ml - 500)} disabled={ml === 0} aria-label="Tirar 500 ml">−500</button>
      </div>
    </section>
  )
}

function PhotoSlot({ label, path, onPick, busy }: { label: string; path: string | null; onPick: (f: File) => void; busy: boolean }) {
  const ref = useRef<HTMLInputElement>(null)
  const url = useStore((s) => (path ? s.photoUrls[path] : undefined))
  return (
    <div className="photo-slot">
      <input ref={ref} type="file" accept="image/*" capture="environment" hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onPick(f)
          e.target.value = ''
        }} />
      <button className="photo-box" onClick={() => ref.current?.click()} disabled={busy} aria-label={`${path ? 'Trocar' : 'Tirar'} foto de ${label.toLowerCase()}`}>
        {url ? <img src={url} alt={`Foto de ${label.toLowerCase()}`} /> : path ? <span className="muted small">foto salva</span> : <Icon name="camera" size={28} />}
      </button>
      <span className="small">{busy ? 'Enviando…' : label}</span>
    </div>
  )
}

export function BodyCard({ date, checkin }: { date: string; checkin: BodyCheckin | null }) {
  const [busy, setBusy] = useState<'' | 'front' | 'side'>('')
  const previous = useStore((s) =>
    (s.view?.body ?? [])
      .filter((b) => b.date < date && b.weight_kg != null)
      .sort((a, b) => b.date.localeCompare(a.date))[0],
  )
  const base: BodyCheckin = checkin ?? { id: stableId('body', date), date, weight_kg: null, photo_front: null, photo_side: null, note: '' }
  const save = (patch: Partial<BodyCheckin>) => dispatch({ t: 'body.upsert', row: { ...base, ...patch } })

  const pick = async (which: 'front' | 'side', file: File) => {
    setBusy(which)
    try {
      const { path, url } = await uploadPhoto(date, file)
      if (url) setPhotoUrl(path, url)
      save(which === 'front' ? { photo_front: path } : { photo_side: path })
      toast('Foto salva')
    } catch (err) {
      toast(err instanceof ApiError && err.status === 0 ? 'Sem internet: tire a foto de novo quando voltar' : `Erro na foto: ${(err as Error).message}`, 'erro')
    } finally {
      setBusy('')
    }
  }

  const delta = checkin?.weight_kg != null && previous?.weight_kg != null ? Math.round((checkin.weight_kg - previous.weight_kg) * 10) / 10 : null
  return (
    <section className="card body-card" aria-label="Peso e fotos">
      <div className="body-head">
        <div>
          <b>Peso e fotos · {WEEKDAY_LONG[weekdayOf(date)].toLowerCase()}</b>
          <p className="muted small">Em jejum, de manhã, depois do banheiro. Mesma luz e distância nas fotos.</p>
        </div>
        {delta != null && (
          <span className={`badge ${delta <= 0 ? 'dentro' : 'acima'}`}>
            {delta > 0 ? '+' : delta < 0 ? '−' : ''}{formatKg(Math.abs(delta))} kg vs {formatShort(previous!.date)}
          </span>
        )}
      </div>
      <div className="body-grid">
        <Field label="Peso (kg)" hint={previous?.weight_kg != null ? `Anterior: ${formatKg(previous.weight_kg)} kg (${formatShort(previous.date)})` : undefined}>
          {(id) => (
            <LazyInput id={id} inputMode="decimal" placeholder="84,5" value={checkin?.weight_kg != null ? formatKg(checkin.weight_kg) : ''}
              onCommit={(v) => {
                const kg = parseKg(v)
                if (v.trim() && kg == null) return toast('Peso inválido. Use, por exemplo, 84,5', 'erro')
                save({ weight_kg: kg })
              }} />
          )}
        </Field>
        <PhotoSlot label="Frente" path={checkin?.photo_front ?? null} busy={busy === 'front'} onPick={(f) => void pick('front', f)} />
        <PhotoSlot label="Lado" path={checkin?.photo_side ?? null} busy={busy === 'side'} onPick={(f) => void pick('side', f)} />
      </div>
    </section>
  )
}
