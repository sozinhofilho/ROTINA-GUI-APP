import { useEffect, useState } from 'react'
import { expandDay, type DayMeal, type DayStats, type DayWorkout } from '../../shared/calc.ts'
import { addDays, formatDayLabel, formatShort, nowHHMM, todayISO, weekdayOf } from '../../shared/dates.ts'
import { uuid } from '../../shared/logic.ts'
import type { AppData, ExtraCategory, ExtraEntry, MealLog, WorkoutLog } from '../../shared/types.ts'
import { MoveWorkoutSheet } from '../components/MoveWorkoutSheet.tsx'
import { CheckButton, Field, Icon, LazyInput, Sheet } from '../components/ui.tsx'
import { fmt, toIntOrNull } from '../lib/format.ts'
import { dispatch, ensureRange, useStore } from '../lib/store.ts'
import { BodyCard, WaterCard } from '../components/BodyWater.tsx'

export function Today({ date, setDate }: { date: string; setDate: (d: string) => void }) {
  const data = useStore((s) => s.view)
  const tz = data?.settings.timezone
  const today = todayISO(tz)

  useEffect(() => {
    void ensureRange(addDays(date, -7), addDays(date, 7))
  }, [date])

  if (!data) return <div className="empty">Carregando…</div>
  const day = expandDay(date, data)

  return (
    <div className="screen">
      <header className="day-head">
        <button className="icon-btn big" onClick={() => setDate(addDays(date, -1))} aria-label="Dia anterior">
          <Icon name="left" size={26} />
        </button>
        <div className="day-title">
          <h1>{date === today ? 'Hoje' : formatDayLabel(date)}</h1>
          {date === today ? (
            <span className="muted">{formatDayLabel(date)}</span>
          ) : (
            <button className="link" onClick={() => setDate(today)}>
              voltar para hoje
            </button>
          )}
        </div>
        <button className="icon-btn big" onClick={() => setDate(addDays(date, 1))} aria-label="Próximo dia">
          <Icon name="right" size={26} />
        </button>
      </header>

      <Progress stats={day.stats} />

      <WaterCard date={date} ml={day.stats.waterMl} goal={day.stats.waterGoal} />

      {(weekdayOf(date) === 1 || weekdayOf(date) === 5 || day.body) && <BodyCard date={date} checkin={day.body} />}

      <section>
        <h2 className="section-title">
          Refeições <span className="muted">{day.stats.mealsDone}/{day.stats.mealsTotal}</span>
        </h2>
        {day.meals.length === 0 && <p className="empty">Nenhuma refeição no plano deste dia.</p>}
        {day.meals.map((m) => (
          <MealCard key={m.plan?.id ?? m.log!.id} date={date} meal={m} />
        ))}
      </section>

      <section>
        <h2 className="section-title">
          Treinos <span className="muted">{day.stats.workoutsDone} feito(s)</span>
        </h2>
        {day.workouts.length === 0 && <p className="empty">Dia de descanso.</p>}
        {day.workouts.map((w) => (
          <WorkoutCard key={(w.plan?.id ?? '') + (w.log?.id ?? '')} date={date} item={w} data={data} />
        ))}
        {day.movedAway.map(({ plan, override }) => (
          <div key={override.id} className="moved-note">
            <Icon name="swap" size={18} />
            <span>
              {plan.name} foi para {formatDayLabel(override.to_date)}
            </span>
            <button className="link" onClick={() => dispatch({ t: 'override.delete', id: override.id })}>
              desfazer
            </button>
          </div>
        ))}
      </section>

      <Extras date={date} extras={day.extras} />
    </div>
  )
}

function Progress({ stats }: { stats: DayStats }) {
  const scaleMax = Math.max(stats.max * 1.1, stats.kcalIn)
  const pct = (n: number) => `${Math.min(100, (n / scaleMax) * 100)}%`
  const label = {
    vazio: 'Nada registrado ainda',
    abaixo: `Abaixo da meta · faltam ${fmt(stats.min - stats.kcalIn)} kcal`,
    dentro: 'Dentro da meta',
    acima: `Acima da meta · ${fmt(stats.kcalIn - stats.max)} kcal a mais`,
  }[stats.status]
  return (
    <div className={`card progress ${stats.status}`}>
      <div className="progress-top">
        <div>
          <span className="big-num">{fmt(stats.kcalIn)}</span>
          <span className="muted"> / {fmt(stats.goal)} kcal</span>
        </div>
        <span className={`badge ${stats.status}`}>{stats.status === 'dentro' ? 'Na meta' : stats.status === 'vazio' ? '—' : stats.status === 'abaixo' ? 'Abaixo' : 'Acima'}</span>
      </div>
      <div className="bar" role="img" aria-label={`${stats.kcalIn} de ${stats.goal} kcal`}>
        <div className="bar-band" style={{ left: pct(stats.min), width: `calc(${pct(stats.max)} - ${pct(stats.min)})` }} />
        <div className="bar-fill" style={{ width: pct(stats.kcalIn) }} />
        <div className="bar-goal" style={{ left: pct(stats.goal) }} />
      </div>
      <p className="progress-label">{label}</p>
      <div className="stats-row">
        <div>
          <span className="muted">Proteína</span>
          <b>
            {fmt(Math.round(stats.proteinDone))}/{fmt(Math.round(stats.proteinPlanned))} g
          </b>
        </div>
        <div>
          <span className="muted">{stats.base != null ? 'Gasto' : 'Gasto treinos'}</span>
          <b>{fmt(stats.spent)} kcal</b>
        </div>
        {stats.balance != null && (
          <div>
            <span className="muted">Saldo</span>
            <b>
              {stats.balance > 0 ? '+' : ''}
              {fmt(stats.balance)}
            </b>
          </div>
        )}
      </div>
    </div>
  )
}

function emptyMealLog(date: string, m: DayMeal): MealLog {
  return {
    id: uuid(),
    date,
    plan_meal_id: m.plan?.id ?? null,
    meal_name: m.name,
    done: false,
    kcal_planned: m.plan?.kcal ?? null,
    kcal_real: null,
    note: '',
    photo_path: null,
    ai_estimate: null,
  }
}

function MealCard({ date, meal }: { date: string; meal: DayMeal }) {
  const [open, setOpen] = useState(false)
  const log = meal.log
  const plan = meal.plan
  const done = !!log?.done

  const save = (patch: Partial<MealLog>) => {
    const base = log ?? emptyMealLog(date, meal)
    dispatch({ t: 'meal_log.upsert', row: { ...base, ...patch } })
  }

  const kcalShown = log?.kcal_real ?? plan?.kcal ?? log?.kcal_planned ?? 0

  return (
    <article className={`card item ${done ? 'done' : ''}`}>
      <div className="item-main">
        <button className="item-info" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="time">{meal.time ?? '--:--'}</span>
          <span className="item-name">
            {meal.name}
            {!plan && <span className="tag">fora do plano</span>}
          </span>
          <span className="muted small">
            {fmt(kcalShown)} kcal
            {log?.kcal_real != null && plan && log.kcal_real !== plan.kcal ? ` (previsto ${fmt(plan.kcal)})` : ''}
            {plan?.protein != null && ` · P ${plan.protein} · C ${plan.carbs ?? '–'} · G ${plan.fat ?? '–'}`}
          </span>
          {plan?.description && <span className="desc">{plan.description}</span>}
          {log?.note && !open && <span className="note-preview">“{log.note}”</span>}
        </button>
        <CheckButton checked={done} onToggle={() => save({ done: !done })} label={`Marcar ${meal.name}`} />
      </div>

      {open && (
        <div className="item-details">
          {plan && plan.items.length > 0 && (
            <table className="items">
              <tbody>
                {plan.items.map((i, idx) => (
                  <tr key={idx}>
                    <td>{i.food}</td>
                    <td className="r">{i.qty}</td>
                    <td className="r muted">{i.kcal ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Field label="Calorias reais" hint="Vazio = usa o previsto. Para conferir pela foto do prato, mande no chat do Claude.">
            {(id) => (
              <LazyInput id={id} value={log?.kcal_real?.toString() ?? ''} inputMode="numeric"
                placeholder={String(plan?.kcal ?? '')} onCommit={(v) => save({ kcal_real: toIntOrNull(v) })} />
            )}
          </Field>
          <Field label="Observação">
            {(id) => <LazyInput id={id} multiline value={log?.note ?? ''} onCommit={(v) => save({ note: v })} placeholder="Ex.: troquei arroz por batata" />}
          </Field>
          {!plan && log && (
            <button className="link danger" onClick={() => dispatch({ t: 'meal_log.delete', id: log.id })}>
              apagar registro
            </button>
          )}
        </div>
      )}
    </article>
  )
}

function WorkoutCard({ date, item, data }: { date: string; item: DayWorkout; data: AppData }) {
  const [open, setOpen] = useState(false)
  const [moving, setMoving] = useState(false)
  const { plan, log, movedFrom } = item
  const done = !!log?.done

  const save = (patch: Partial<WorkoutLog>) => {
    const base: WorkoutLog = log ?? {
      id: uuid(),
      date,
      plan_workout_id: plan?.id ?? null,
      name: item.name,
      done: false,
      duration_min: plan?.duration_min ?? null,
      kcal: plan?.kcal ?? null,
      distance_m: null,
      avg_hr: null,
      avg_pace: null,
      note: '',
      source: 'manual',
      strava_activity_id: null,
    }
    dispatch({ t: 'workout_log.upsert', row: { ...base, ...patch } })
  }

  const dayPlans = expandDay(date, data).workouts.filter((w) => w.plan).map((w) => w.plan!)

  return (
    <article className={`card item ${done ? 'done' : ''}`}>
      <div className="item-main">
        <button className="item-info" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="item-name">
            {log?.name || item.name}
            {log?.source === 'strava' && <span className="tag strava">Strava</span>}
            {log?.source === 'import' && <span className="tag">importado</span>}
            {!plan && log?.source !== 'strava' && <span className="tag">avulso</span>}
            {movedFrom && <span className="tag">de {formatShort(movedFrom.from_date)}</span>}
          </span>
          <span className="muted small">
            {log?.duration_min ?? plan?.duration_min ?? '–'} min · {fmt(log?.kcal ?? plan?.kcal ?? 0)} kcal
            {log?.distance_m ? ` · ${(log.distance_m / 1000).toFixed(1)} km` : ''}
            {log?.avg_pace ? ` · ${log.avg_pace}/km` : ''}
            {log?.avg_hr ? ` · FC ${Math.round(log.avg_hr)}` : ''}
            {!log?.done && plan?.kcal != null && ' (estimado)'}
          </span>
          {plan?.details && <span className="desc">{plan.details}</span>}
        </button>
        <CheckButton checked={done} onToggle={() => save({ done: !done })} label={`Marcar ${item.name}`} />
      </div>

      {open && (
        <div className="item-details">
          {plan && plan.exercises.length > 0 && (
            <table className="items">
              <thead>
                <tr>
                  <th>Exercício</th>
                  <th className="r">Séries</th>
                  <th className="r">Reps</th>
                </tr>
              </thead>
              <tbody>
                {plan.exercises.map((e, idx) => (
                  <tr key={idx}>
                    <td>{e.name}</td>
                    <td className="r">{e.sets}</td>
                    <td className="r">{e.reps}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="grid2">
            <Field label="Duração (min)">
              {(id) => (
                <LazyInput id={id} inputMode="numeric" value={log?.duration_min?.toString() ?? ''}
                  placeholder={plan?.duration_min?.toString() ?? ''} onCommit={(v) => save({ duration_min: toIntOrNull(v) })} />
              )}
            </Field>
            <Field label="Calorias gastas">
              {(id) => (
                <LazyInput id={id} inputMode="numeric" value={log?.kcal?.toString() ?? ''}
                  placeholder={plan?.kcal?.toString() ?? ''} onCommit={(v) => save({ kcal: toIntOrNull(v) })} />
              )}
            </Field>
          </div>
          <Field label="Observação">
            {(id) => <LazyInput id={id} multiline value={log?.note ?? ''} onCommit={(v) => save({ note: v })} placeholder="Ex.: cargas, pace, como se sentiu" />}
          </Field>
          {!plan && log && dayPlans.length > 0 && (
            <Field label="Este treino cumpre qual do plano?">
              {(id) => (
                <select id={id} value="" onChange={(e) => e.target.value && dispatch({ t: 'workout_log.assign', id: log.id, plan_workout_id: e.target.value })}>
                  <option value="">Escolher…</option>
                  {dayPlans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <div className="row wrap">
            {plan && (
              <button className="btn secondary" onClick={() => setMoving(true)}>
                <Icon name="swap" size={18} /> Trocar de dia
              </button>
            )}
            {plan && log?.source === 'strava' && (
              <button className="btn secondary" onClick={() => dispatch({ t: 'workout_log.assign', id: log.id, plan_workout_id: null })}>
                Não é este treino
              </button>
            )}
            {log && (!plan || log.source !== 'manual') && (
              <button className="btn danger" onClick={() => dispatch({ t: 'workout_log.delete', id: log.id })}>
                <Icon name="trash" size={18} /> Apagar registro
              </button>
            )}
          </div>
        </div>
      )}
      <MoveWorkoutSheet
        open={moving}
        onClose={() => setMoving(false)}
        workout={plan}
        fromDate={movedFrom?.from_date ?? date}
        existing={movedFrom}
      />
    </article>
  )
}

const CATEGORIES: { value: ExtraCategory; label: string }[] = [
  { value: 'alcool', label: 'Álcool' },
  { value: 'lanche', label: 'Lanche' },
  { value: 'refeicao', label: 'Refeição fora' },
  { value: 'outro', label: 'Outro' },
]

function Extras({ date, extras }: { date: string; extras: ExtraEntry[] }) {
  const [editing, setEditing] = useState<ExtraEntry | null>(null)
  const tz = useStore((s) => s.view?.settings.timezone)
  const startNew = () =>
    setEditing({ id: uuid(), date, time: date === todayISO(tz) ? nowHHMM(tz) : null, description: '', kcal: 0, category: 'lanche' })

  return (
    <section>
      <h2 className="section-title">
        Extras <span className="muted">{fmt(extras.reduce((s, e) => s + e.kcal, 0))} kcal</span>
      </h2>
      {extras.map((e) => (
        <button key={e.id} className="card extra" onClick={() => setEditing(e)}>
          <span className="time">{e.time ?? '--:--'}</span>
          <span className="item-name">
            {e.description}
            <span className="tag">{CATEGORIES.find((c) => c.value === e.category)?.label}</span>
          </span>
          <b>{fmt(e.kcal)} kcal</b>
        </button>
      ))}
      <button className="btn block add" onClick={startNew}>
        <Icon name="plus" /> Adicionar extra
      </button>
      {editing && (
        <ExtraSheet
          entry={editing}
          isNew={!extras.some((e) => e.id === editing.id)}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  )
}

function ExtraSheet({ entry, isNew, onClose }: { entry: ExtraEntry; isNew: boolean; onClose: () => void }) {
  const [e, setE] = useState(entry)
  const [kcalText, setKcalText] = useState(entry.kcal ? String(entry.kcal) : '')
  const kcal = toIntOrNull(kcalText)
  const valid = e.description.trim().length > 0 && kcal != null
  return (
    <Sheet open title={isNew ? 'Adicionar extra' : 'Editar extra'} onClose={onClose}>
      <div className="chips">
        {CATEGORIES.map((c) => (
          <button key={c.value} className={`chip ${e.category === c.value ? 'on' : ''}`} onClick={() => setE({ ...e, category: c.value })}>
            {c.label}
          </button>
        ))}
      </div>
      <Field label="Descrição">
        {(id) => <input id={id} value={e.description} placeholder="Ex.: 2 latas de cerveja" onChange={(ev) => setE({ ...e, description: ev.target.value })} autoFocus />}
      </Field>
      <div className="grid2">
        <Field label="Calorias">
          {(id) => <input id={id} inputMode="numeric" value={kcalText} onChange={(ev) => setKcalText(ev.target.value)} placeholder="0" />}
        </Field>
        <Field label="Horário">
          {(id) => <input id={id} type="time" value={e.time ?? ''} onChange={(ev) => setE({ ...e, time: ev.target.value || null })} />}
        </Field>
      </div>
      <button
        className="btn block"
        disabled={!valid}
        onClick={() => {
          dispatch({ t: 'extra.upsert', row: { ...e, description: e.description.trim(), kcal: kcal ?? 0 } })
          onClose()
        }}
      >
        Salvar
      </button>
      {!isNew && (
        <button
          className="btn danger block"
          onClick={() => {
            dispatch({ t: 'extra.delete', id: e.id })
            onClose()
          }}
        >
          Apagar
        </button>
      )}
    </Sheet>
  )
}
