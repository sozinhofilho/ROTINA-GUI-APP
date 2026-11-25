import { useEffect, useState } from 'react'
import { todayISO } from '../shared/dates.ts'
import { Icon } from './components/ui.tsx'
import { getToken } from './lib/api.ts'
import { useStore } from './lib/store.ts'
import { Export } from './screens/Export.tsx'
import { Plan } from './screens/Plan.tsx'
import { Summary } from './screens/Summary.tsx'
import { Today } from './screens/Today.tsx'

type Tab = 'hoje' | 'plano' | 'resumo' | 'exportar'
const TABS: { id: Tab; label: string; icon: 'today' | 'plan' | 'chart' | 'download' }[] = [
  { id: 'hoje', label: 'Hoje', icon: 'today' },
  { id: 'plano', label: 'Plano', icon: 'plan' },
  { id: 'resumo', label: 'Resumo', icon: 'chart' },
  { id: 'exportar', label: 'Exportar', icon: 'download' },
]

function tabFromHash(): Tab {
  const h = window.location.hash.replace('#', '') as Tab
  return TABS.some((t) => t.id === h) ? h : 'hoje'
}

export default function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash)
  const tz = useStore((s) => s.view?.settings.timezone)
  const [date, setDate] = useState(() => todayISO(tz))
  const authError = useStore((s) => s.authError)

  useEffect(() => {
    const onHash = () => setTab(tabFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Ao voltar para o app num novo dia, abre no dia atual.
  useEffect(() => {
    let last = todayISO(tz)
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const now = todayISO(tz)
      if (now !== last) {
        last = now
        setDate(now)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [tz])

  const go = (t: Tab) => {
    window.history.replaceState(null, '', `${window.location.pathname}#${t}`)
    setTab(t)
    window.scrollTo(0, 0)
  }

  if (!getToken() || authError) {
    return (
      <main className="locked">
        <h1>Rotina</h1>
        <p>{authError ? 'O link de acesso não é mais válido.' : 'Abra o app pelo seu link secreto (com ?k=…).'}</p>
      </main>
    )
  }

  return (
    <>
      <StatusBar />
      <main>
        {tab === 'hoje' && <Today date={date} setDate={setDate} />}
        {tab === 'plano' && <Plan />}
        {tab === 'resumo' && <Summary />}
        {tab === 'exportar' && <Export goToDay={(d) => { setDate(d); go('hoje') }} />}
      </main>
      <Toast />
      <nav className="tabbar">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => go(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
            <Icon name={t.icon} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </>
  )
}

function StatusBar() {
  const online = useStore((s) => s.online)
  const pending = useStore((s) => s.pending.length)
  const syncing = useStore((s) => s.syncing)
  if (online && pending === 0) return null
  return (
    <div className={`statusbar ${online ? '' : 'offline'}`} role="status">
      <Icon name="cloud" size={16} />
      {!online ? `Sem internet · ${pending} registro(s) guardado(s) no celular` : syncing ? 'Sincronizando…' : `${pending} registro(s) aguardando envio`}
    </div>
  )
}

function Toast() {
  const t = useStore((s) => s.toast)
  if (!t) return null
  return <div className={`toast ${t.kind}`} role="alert">{t.text}</div>
}
