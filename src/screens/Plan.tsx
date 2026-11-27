import { useEffect, useState } from 'react'
import { addDays, formatDayLabel, todayISO, weekdayOf, weekStart, WEEKDAY_LONG, WEEKDAY_SHORT } from '../../shared/dates.ts'
import { uuid } from '../../shared/logic.ts'
import { formatZodError, ImportPlanSchema } from '../../shared/schemas.ts'
import type { Exercise, MealItem, PlanMeal, PlanWorkout, Settings, WorkoutKind } from '../../shared/types.ts'
import { MoveWorkoutSheet } from '../components/MoveWorkoutSheet.tsx'
import { Field, Icon, LazyInput, Sheet } from '../components/ui.tsx'
import { fmt, toIntOrNull } from '../lib/format.ts'
import { api, postJson } from '../lib/api.ts'
import { dispatch, ensureRange, invalidate, toast, useStore } from '../lib/store.ts'

const ORDER = [1, 2, 3, 4, 5, 6, 0] // seg..dom

export function Plan() {
  const data = useStore((s) => s.view)
  const [wd, setWd] = useState(() => weekdayOf(todayISO()))
  const [editMeal, setEditMeal] = useState<PlanMeal | null>(null)
  const [editWorkout, setEditWorkout] = useState<PlanWorkout | null>(null)
  const [moving, setMoving] = useState<PlanWorkout | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const today = todayISO(data?.settings.timezone)
  const ws = weekStart(today)
  useEffect(() => {
    void ensureRange(addDays(ws, -7), addDays(ws, 13))
  }, [ws])

  if (!data) return <div className="empty">Carregando…</div>
  const meals = data.plan_meals.filter((m) => m.weekday === wd).sort((a, b) => a.time.localeCompare(b.time))
  const workouts = data.plan_workouts.filter((w) => w.weekday === wd).sort((a, b) => a.sort - b.sort)
  const totalKcal = meals.reduce((s, m) => s + m.kcal, 0)
  const thisWeekDate = addDays(ws, (wd + 6) % 7)
  const overrides = data.overrides
    .filter((o) => o.from_date >= addDays(ws, -7) || o.to_date >= addDays(ws, -7))
    .sort((a, b) => a.from_date.localeCompare(b.from_date))

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Plano</h1>
      </header>

      <SettingsCard settings={data.settings} />

      <div className="chips weekdays" role="tablist">
        {ORDER.map((d) => (
          <button key={d} role="tab" aria-selected={wd === d} className={`chip ${wd === d ? 'on' : ''}`} onClick={() => setWd(d)}>
            {WEEKDAY_SHORT[d]}
          </button>
        ))}
      </div>

      <section>
        <h2 className="section-title">
          {WEEKDAY_LONG[wd]} · refeições <span className="muted">{fmt(totalKcal)} kcal</span>
        </h2>
        {meals.map((m) => (
          <button key={m.id} className="card plan-row" onClick={() => setEditMeal(m)}>
            <span className="time">{m.time}</span>
            <span className="item-name">{m.name}</span>
            <span className="muted small">{fmt(m.kcal)} kcal</span>
            <Icon name="edit" size={18} />
          </button>
        ))}
        <button className="btn secondary block" onClick={() => setEditMeal(newMeal(wd))}>
          <Icon name="plus" /> Nova refeição
        </button>
      </section>

      <section>
        <h2 className="section-title">{WEEKDAY_LONG[wd]} · treinos</h2>
        {workouts.length === 0 && <p className="empty">Sem treino neste dia.</p>}
        {workouts.map((w) => (
          <div key={w.id} className="card plan-row">
            <button className="plan-row-main" onClick={() => setEditWorkout(w)}>
              <span className="item-name">{w.name}</span>
              <span className="muted small">
                {w.duration_min ?? '–'} min · {fmt(w.kcal ?? 0)} kcal
              </span>
            </button>
            <button className="btn secondary small" onClick={() => setMoving(w)}>
              <Icon name="swap" size={16} /> Trocar de dia
            </button>
          </div>
        ))}
        <button className="btn secondary block" onClick={() => setEditWorkout(newWorkout(wd))}>
          <Icon name="plus" /> Novo treino
        </button>
      </section>

      {overrides.length > 0 && (
        <section>
          <h2 className="section-title">Trocas de dia</h2>
          {overrides.map((o) => {
            const w = data.plan_workouts.find((x) => x.id === o.plan_workout_id)
            return (
              <div key={o.id} className="card plan-row">
                <span className="item-name">
                  {w?.name ?? 'Treino'}: {formatDayLabel(o.from_date)} → {formatDayLabel(o.to_date)}
                </span>
                <button className="link danger" onClick={() => dispatch({ t: 'override.delete', id: o.id })}>
                  desfazer
                </button>
              </div>
            )
          })}
        </section>
      )}

      <section>
        <h2 className="section-title">Ferramentas</h2>
        <button className="btn secondary block" onClick={() => setImportOpen(true)}>
          Importar plano (JSON)
        </button>
        <StravaCard />
      </section>

      {editMeal && <MealEditor meal={editMeal} onClose={() => setEditMeal(null)} isNew={!data.plan_meals.some((m) => m.id === editMeal.id)} />}
      {editWorkout && (
        <WorkoutEditor workout={editWorkout} onClose={() => setEditWorkout(null)} isNew={!data.plan_workouts.some((w) => w.id === editWorkout.id)} />
      )}
      <MoveWorkoutSheet
        open={!!moving}
        onClose={() => setMoving(null)}
        workout={moving}
        fromDate={thisWeekDate}
        existing={moving ? data.overrides.find((o) => o.plan_workout_id === moving.id && o.from_date === thisWeekDate) : null}
      />
      <ImportPlanSheet open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  )
}

function newMeal(weekday: number): PlanMeal {
  return { id: uuid(), weekday, name: '', time: '12:00', description: '', items: [], kcal: 0, protein: null, carbs: null, fat: null, sort: 0 }
}

function newWorkout(weekday: number): PlanWorkout {
  return { id: uuid(), weekday, name: '', kind: 'strength', time: null, details: '', exercises: [], duration_min: 60, kcal: null, sort: 99 }
}

function SettingsCard({ settings }: { settings: Settings }) {
  const update = (row: Partial<Settings>) => dispatch({ t: 'settings.update', row })
  return (
    <div className="card settings" id="ajustes">
      <b>Ajustes</b>
      <div className="grid4 settings-grid">
        <Field label="Meta (kcal)">
          {(id) => (
            <LazyInput id={id} inputMode="numeric" value={String(settings.calorie_goal)}
              onCommit={(v) => {
                const n = toIntOrNull(v)
                if (n != null && n >= 500) update({ calorie_goal: n })
              }} />
          )}
        </Field>
        <Field label="Tolerância (%)">
          {(id) => (
            <LazyInput id={id} inputMode="decimal" value={String(settings.tolerance_pct)}
              onCommit={(v) => {
                const n = Number(v.replace(',', '.'))
                if (Number.isFinite(n) && n >= 0 && n <= 100) update({ tolerance_pct: n })
              }} />
          )}
        </Field>
        <Field label="Gasto basal">
          {(id) => (
            <LazyInput id={id} inputMode="numeric" value={settings.base_expenditure?.toString() ?? ''} placeholder="opcional"
              onCommit={(v) => update({ base_expenditure: toIntOrNull(v) })} />
          )}
        </Field>
        <Field label="Água (L)">
          {(id) => (
            <LazyInput id={id} inputMode="decimal" value={String((settings.water_goal_ml ?? 5000) / 1000).replace('.', ',')}
              onCommit={(v) => {
                const l = Number(v.replace(',', '.'))
                if (Number.isFinite(l) && l >= 0 && l <= 15) update({ water_goal_ml: Math.round(l * 1000) })
              }} />
          )}
        </Field>
      </div>
      <small className="muted">
        Dentro da meta: {fmt(Math.round(settings.calorie_goal * (1 - settings.tolerance_pct / 100)))} a{' '}
        {fmt(Math.round(settings.calorie_goal * (1 + settings.tolerance_pct / 100)))} kcal. Gasto basal = quanto você gasta por dia sem treino (kcal). É a base do saldo na aba Evolução.
      </small>
    </div>
  )
}

function WeekdayPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div className="chips">
      {ORDER.map((d) => {
        const on = value.includes(d)
        return (
          <button key={d} className={`chip ${on ? 'on' : ''}`}
            onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d])}>
            {WEEKDAY_SHORT[d]}
          </button>
        )
      })}
    </div>
  )
}

function MealEditor({ meal, isNew, onClose }: { meal: PlanMeal; isNew: boolean; onClose: () => void }) {
  const all = useStore((s) => s.view?.plan_meals ?? [])
  const [m, setM] = useState(meal)
  const [itemsText, setItemsText] = useState(meal.items.map((i) => `${i.food}; ${i.qty}; ${i.kcal ?? ''}`).join('\n'))
  const twins = all.filter((x) => x.id !== meal.id && x.name === meal.name && x.time === meal.time)
  const [alsoDays, setAlsoDays] = useState<number[]>(isNew ? [meal.weekday] : [meal.weekday, ...twins.map((t) => t.weekday)])
  const num = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.')))

  const items: MealItem[] = itemsText
    .split('\n')
    .map((l) => l.split(';').map((p) => p.trim()))
    .filter((p) => p[0])
    .map(([food, qty = '', kcal = '']) => ({ food, qty, kcal: toIntOrNull(kcal) }))

  const valid = m.name.trim() && /^\d{2}:\d{2}$/.test(m.time) && alsoDays.length > 0

  const save = () => {
    const base = { ...m, name: m.name.trim(), items }
    const ops = alsoDays.map((wd) => {
      const twin = wd === meal.weekday ? meal : twins.find((t) => t.weekday === wd)
      return { t: 'plan_meal.upsert' as const, row: { ...base, id: twin?.id ?? uuid(), weekday: wd } }
    })
    const removed = twins.filter((t) => !alsoDays.includes(t.weekday))
    dispatch([...ops, ...removed.map((t) => ({ t: 'plan_meal.delete' as const, id: t.id }))])
    toast('Plano salvo')
    onClose()
  }

  return (
    <Sheet open title={isNew ? 'Nova refeição' : `Editar ${meal.name}`} onClose={onClose}>
      <div className="grid2">
        <Field label="Nome">{(id) => <input id={id} value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} />}</Field>
        <Field label="Horário">{(id) => <input id={id} type="time" value={m.time} onChange={(e) => setM({ ...m, time: e.target.value })} />}</Field>
      </div>
      <Field label="O que comer">
        {(id) => <textarea id={id} rows={2} value={m.description} onChange={(e) => setM({ ...m, description: e.target.value })} />}
      </Field>
      <Field label="Alimentos (um por linha: alimento; quantidade; kcal)">
        {(id) => <textarea id={id} rows={5} value={itemsText} onChange={(e) => setItemsText(e.target.value)} placeholder="Arroz branco; 200 g; 256" />}
      </Field>
      <div className="grid4">
        <Field label="Kcal">{(id) => <input id={id} inputMode="numeric" value={m.kcal || ''} onChange={(e) => setM({ ...m, kcal: toIntOrNull(e.target.value) ?? 0 })} />}</Field>
        <Field label="Prot.">{(id) => <input id={id} inputMode="decimal" value={m.protein ?? ''} onChange={(e) => setM({ ...m, protein: num(e.target.value) })} />}</Field>
        <Field label="Carb.">{(id) => <input id={id} inputMode="decimal" value={m.carbs ?? ''} onChange={(e) => setM({ ...m, carbs: num(e.target.value) })} />}</Field>
        <Field label="Gord.">{(id) => <input id={id} inputMode="decimal" value={m.fat ?? ''} onChange={(e) => setM({ ...m, fat: num(e.target.value) })} />}</Field>
      </div>
      {items.some((i) => i.kcal != null) && (
        <button className="link" onClick={() => setM({ ...m, kcal: items.reduce((s, i) => s + (i.kcal ?? 0), 0) })}>
          usar soma dos alimentos ({fmt(items.reduce((s, i) => s + (i.kcal ?? 0), 0))} kcal)
        </button>
      )}
      <Field label="Dias da semana">{() => <WeekdayPicker value={alsoDays} onChange={setAlsoDays} />}</Field>
      <button className="btn block" disabled={!valid} onClick={save}>Salvar</button>
      {!isNew && (
        <button className="btn danger block" onClick={() => {
          dispatch({ t: 'plan_meal.delete', id: meal.id })
          onClose()
        }}>
          Apagar só de {WEEKDAY_LONG[meal.weekday]}
        </button>
      )}
    </Sheet>
  )
}

const KINDS: { value: WorkoutKind; label: string }[] = [
  { value: 'hyrox', label: 'HYROX' },
  { value: 'run', label: 'Corrida' },
  { value: 'strength', label: 'Musculação' },
  { value: 'other', label: 'Outro' },
]

function WorkoutEditor({ workout, isNew, onClose }: { workout: PlanWorkout; isNew: boolean; onClose: () => void }) {
  const [w, setW] = useState(workout)
  const [exText, setExText] = useState(workout.exercises.map((e) => `${e.name}; ${e.sets}; ${e.reps}`).join('\n'))
  const exercises: Exercise[] = exText
    .split('\n')
    .map((l) => l.split(';').map((p) => p.trim()))
    .filter((p) => p[0])
    .map(([name, sets = '', reps = '']) => ({ name, sets, reps }))
  return (
    <Sheet open title={isNew ? 'Novo treino' : `Editar ${workout.name}`} onClose={onClose}>
      <Field label="Nome">{(id) => <input id={id} value={w.name} onChange={(e) => setW({ ...w, name: e.target.value })} />}</Field>
      <div className="chips">
        {KINDS.map((k) => (
          <button key={k.value} className={`chip ${w.kind === k.value ? 'on' : ''}`} onClick={() => setW({ ...w, kind: k.value })}>{k.label}</button>
        ))}
      </div>
      <div className="grid3">
        <Field label="Duração (min)">{(id) => <input id={id} inputMode="numeric" value={w.duration_min ?? ''} onChange={(e) => setW({ ...w, duration_min: toIntOrNull(e.target.value) })} />}</Field>
        <Field label="Kcal (estim.)">{(id) => <input id={id} inputMode="numeric" value={w.kcal ?? ''} onChange={(e) => setW({ ...w, kcal: toIntOrNull(e.target.value) })} />}</Field>
        <Field label="Dia">
          {(id) => (
            <select id={id} value={w.weekday} onChange={(e) => setW({ ...w, weekday: Number(e.target.value) })}>
              {ORDER.map((d) => <option key={d} value={d}>{WEEKDAY_SHORT[d]}</option>)}
            </select>
          )}
        </Field>
      </div>
      <Field label="Detalhes">{(id) => <textarea id={id} rows={2} value={w.details} onChange={(e) => setW({ ...w, details: e.target.value })} />}</Field>
      <Field label="Exercícios (um por linha: exercício; séries; reps)">
        {(id) => <textarea id={id} rows={6} value={exText} onChange={(e) => setExText(e.target.value)} placeholder="Supino reto; 3; 6–10" />}
      </Field>
      <button className="btn block" disabled={!w.name.trim()} onClick={() => {
        dispatch({ t: 'plan_workout.upsert', row: { ...w, name: w.name.trim(), exercises } })
        toast('Plano salvo')
        onClose()
      }}>Salvar</button>
      {!isNew && (
        <button className="btn danger block" onClick={() => {
          if (!confirm(`Apagar ${workout.name} do plano de ${WEEKDAY_LONG[workout.weekday]}?`)) return
          dispatch({ t: 'plan_workout.delete', id: workout.id })
          onClose()
        }}>Apagar do plano</button>
      )}
    </Sheet>
  )
}

function ImportPlanSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const validate = () => {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (e) {
      return { ok: false as const, text: `JSON inválido: ${(e as Error).message}` }
    }
    const r = ImportPlanSchema.safeParse(raw)
    if (!r.success) return { ok: false as const, text: formatZodError(r.error) }
    return { ok: true as const, raw, plan: r.data }
  }

  const run = async () => {
    const v = validate()
    if (!v.ok) return setMsg(v)
    setBusy(true)
    try {
      const r = await postJson<{ operations: number }>('/api/import-plan', v.raw)
      invalidate()
      await ensureRange(addDays(todayISO(), -7), addDays(todayISO(), 14), { force: true })
      toast(r.operations ? `Plano importado: ${r.operations} alteração(ões)` : 'Nada mudou: o plano já estava assim')
      setText('')
      setMsg(null)
      onClose()
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const check = () => {
    const v = validate()
    if (!v.ok) return setMsg(v)
    const mealRows = v.plan.meals.reduce((s, m) => s + m.weekdays.length, 0)
    const wRows = v.plan.workouts.reduce((s, w) => s + w.weekdays.length, 0)
    setMsg({
      ok: true,
      text: `Válido: ${v.plan.meals.length} refeições (${mealRows} no total da semana), ${v.plan.workouts.length} treinos (${wRows} na semana). ${v.plan.replace ? 'Vai SUBSTITUIR o plano atual das seções enviadas (itens com o mesmo dia e nome são atualizados, mantendo o histórico).' : 'Vai ADICIONAR ao plano atual.'}`,
    })
  }

  return (
    <Sheet open={open} title="Importar plano" onClose={onClose}>
      <p className="muted small">
        Cole o JSON do plano (formato no README). Dica: peça ao Claude no chat “gera o JSON do meu plano no formato do app Rotina”.
      </p>
      <textarea className="mono" rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"replace": true, "meals": [...], "workouts": [...]}' />
      {msg && <pre className={`msg ${msg.ok ? 'ok' : 'erro'}`}>{msg.text}</pre>}
      <div className="row">
        <button className="btn secondary" onClick={check} disabled={!text.trim()}>Validar</button>
        <button className="btn" onClick={() => void run()} disabled={!text.trim() || busy}>{busy ? 'Importando…' : 'Importar'}</button>
      </div>
    </Sheet>
  )
}

function StravaCard() {
  const f = useStore((s) => s.features)
  const [busy, setBusy] = useState('')
  const param = new URLSearchParams(window.location.search).get('strava')
  useEffect(() => {
    if (!param) return
    toast(param === 'ok' ? 'Strava conectado' : 'Strava não conectado', param === 'ok' ? 'ok' : 'erro')
    const url = new URL(window.location.href)
    url.searchParams.delete('strava')
    window.history.replaceState(null, '', url.pathname + url.hash)
  }, [param])

  const act = async (what: string, fn: () => Promise<void>) => {
    setBusy(what)
    try {
      await fn()
    } catch (e) {
      toast(`Strava: ${(e as Error).message}`, 'erro')
    } finally {
      setBusy('')
    }
  }

  if (!f.strava_configured) {
    return <p className="muted small">Strava: ainda não configurado (fase 2, ver README).</p>
  }
  return (
    <div className="card">
      <b>Strava</b> <span className="muted small">{f.strava_connected ? 'conectado' : 'não conectado'}</span>
      <div className="row wrap" style={{ marginTop: 8 }}>
        <button className="btn secondary" disabled={!!busy} onClick={() => void act('c', async () => {
          const r = await api<{ url: string }>('/api/strava/connect')
          window.location.href = r.url
        })}>{f.strava_connected ? 'Reconectar' : 'Conectar Strava'}</button>
        {f.strava_connected && (
          <>
            <button className="btn secondary" disabled={!!busy} onClick={() => void act('s', async () => {
              const r = await postJson<{ imported: number }>('/api/strava/sync?days=7', {})
              invalidate()
              await ensureRange(addDays(todayISO(), -7), addDays(todayISO(), 7), { force: true })
              toast(`${r.imported} atividade(s) importada(s)`)
            })}>{busy === 's' ? 'Buscando…' : 'Buscar últimos 7 dias'}</button>
            <button className="btn secondary" disabled={!!busy} onClick={() => void act('w', async () => {
              await postJson('/api/strava/subscribe', {})
              toast('Webhook do Strava ativado')
            })}>Ativar webhook</button>
          </>
        )}
      </div>
    </div>
  )
}
