import { useState } from 'react'
import { addDays, formatDayLabel, todayISO } from '../../shared/dates.ts'
import { formatZodError, ImportDaySchema } from '../../shared/schemas.ts'
import { Field, Icon } from '../components/ui.tsx'
import { postJson } from '../lib/api.ts'
import { exportXlsx } from '../lib/export.ts'
import { ensureRange, getState, invalidate, toast, useStore } from '../lib/store.ts'

export function Export({ goToDay }: { goToDay: (d: string) => void }) {
  const tz = useStore((s) => s.view?.settings.timezone)
  const today = todayISO(tz)
  const [from, setFrom] = useState(addDays(today, -89))
  const [to, setTo] = useState(today)
  const [busy, setBusy] = useState(false)
  const pending = useStore((s) => s.pending.length)

  const run = async () => {
    setBusy(true)
    try {
      await ensureRange(from, to, { photos: false, force: true })
      const data = getState().view
      if (!data) throw new Error('sem dados (está offline?)')
      await exportXlsx(data, from, to, today)
    } catch (e) {
      toast(`Erro ao exportar: ${(e as Error).message}`, 'erro')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Exportar</h1>
      </header>
      <div className="card">
        <p className="muted small">
          Planilha .xlsx com as abas Resumo diário, Refeições, Treinos, Extras e Resumo semanal.
        </p>
        <div className="grid2">
          <Field label="De">{(id) => <input id={id} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="Até">{(id) => <input id={id} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />}</Field>
        </div>
        <div className="chips">
          <button className="chip" onClick={() => setFrom(addDays(today, -6))}>7 dias</button>
          <button className="chip" onClick={() => setFrom(addDays(today, -29))}>30 dias</button>
          <button className="chip" onClick={() => setFrom(addDays(today, -89))}>90 dias</button>
          <button className="chip" onClick={() => setFrom(addDays(today, -364))}>1 ano</button>
        </div>
        {pending > 0 && <p className="muted small">{pending} registro(s) ainda não sincronizado(s) entram na planilha mesmo assim.</p>}
        <button className="btn block" onClick={() => void run()} disabled={busy || !from || !to}>
          <Icon name="download" /> {busy ? 'Gerando…' : 'Baixar Excel'}
        </button>
      </div>

      <ImportDay goToDay={goToDay} />
    </div>
  )
}

const EXAMPLE = `{
  "date": "${todayISO()}",
  "meals": [{ "name": "Almoço", "done": true, "kcal": 650 }],
  "extras": [{ "description": "2 cervejas", "kcal": 300, "time": "21:00", "category": "alcool" }],
  "workouts": [{ "name": "HYROX", "done": true, "duration_min": 62, "kcal": 740, "avg_hr": 151 }]
}`

function ImportDay({ goToDay }: { goToDay: (d: string) => void }) {
  const [text, setText] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (e) {
      return setMsg({ ok: false, text: `JSON inválido: ${(e as Error).message}` })
    }
    const r = ImportDaySchema.safeParse(raw)
    if (!r.success) return setMsg({ ok: false, text: formatZodError(r.error) })
    setBusy(true)
    try {
      const res = await postJson<{ applied: number }>('/api/import-day', raw)
      invalidate()
      await ensureRange(addDays(r.data.date, -7), addDays(r.data.date, 7), { force: true })
      toast(`${res.applied} lançamento(s) importado(s) em ${formatDayLabel(r.data.date)}`)
      setText('')
      setMsg(null)
      goToDay(r.data.date)
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h2 className="section-title">Importar lançamentos do dia</h2>
      <div className="card">
        <p className="muted small">
          Mande print do Strava ou foto do prato para o Claude no chat, peça o JSON no formato do app e cole aqui.
          Refeições e treinos são casados pelo nome com o plano do dia.
        </p>
        <textarea className="mono" rows={9} value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLE} />
        {msg && <pre className={`msg ${msg.ok ? 'ok' : 'erro'}`}>{msg.text}</pre>}
        <div className="row">
          <button className="btn secondary" onClick={() => setText(EXAMPLE)}>Ver exemplo</button>
          <button className="btn" disabled={!text.trim() || busy} onClick={() => void run()}>{busy ? 'Importando…' : 'Importar'}</button>
        </div>
      </div>
    </section>
  )
}
