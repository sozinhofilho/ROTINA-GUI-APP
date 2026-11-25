import { useState } from 'react'
import { addDays, formatDayLabel, weekStart } from '../../shared/dates.ts'
import { uuid } from '../../shared/logic.ts'
import type { DayOverride, PlanWorkout } from '../../shared/types.ts'
import { dispatch, toast } from '../lib/store.ts'
import { Field, Sheet } from './ui.tsx'

/**
 * "Trocar de dia": move um treino do plano de `fromDate` para outra data, só naquela semana.
 * O plano base não muda; fica uma exceção por data (day_overrides).
 */
export function MoveWorkoutSheet({
  open,
  onClose,
  workout,
  fromDate,
  existing,
}: {
  open: boolean
  onClose: () => void
  workout: PlanWorkout | null
  fromDate: string
  existing?: DayOverride | null
}) {
  const ws = weekStart(fromDate)
  const options = Array.from({ length: 7 }, (_, i) => addDays(ws, i)).filter((d) => d !== fromDate)
  const [other, setOther] = useState('')
  if (!workout) return null

  const move = (to: string) => {
    if (!to || to === fromDate) return
    dispatch({
      t: 'override.upsert',
      row: { id: existing?.id ?? uuid(), plan_workout_id: workout.id, from_date: fromDate, to_date: to },
    })
    toast(`${workout.name} movido para ${formatDayLabel(to)}`)
    onClose()
  }

  return (
    <Sheet open={open} title={`Trocar de dia: ${workout.name}`} onClose={onClose}>
      <p className="muted">
        Previsto para <b>{formatDayLabel(fromDate)}</b>. A troca vale só para esta data; o plano da semana continua igual.
      </p>
      <div className="day-grid">
        {options.map((d) => (
          <button key={d} className="btn secondary" onClick={() => move(d)}>
            {formatDayLabel(d)}
          </button>
        ))}
      </div>
      <Field label="Outra data">
        {(id) => (
          <div className="row">
            <input id={id} type="date" value={other} onChange={(e) => setOther(e.target.value)} />
            <button className="btn" disabled={!other} onClick={() => move(other)}>
              Mover
            </button>
          </div>
        )}
      </Field>
      {existing && (
        <button
          className="btn danger block"
          onClick={() => {
            dispatch({ t: 'override.delete', id: existing.id })
            toast('Troca desfeita')
            onClose()
          }}
        >
          Desfazer troca
        </button>
      )}
    </Sheet>
  )
}
