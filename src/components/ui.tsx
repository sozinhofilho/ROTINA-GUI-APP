import { useEffect, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function Icon({ name, size = 22 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  )
}

const PATHS = {
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  left: <path d="M15 5l-7 7 7 7" />,
  right: <path d="M9 5l7 7-7 7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  camera: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  today: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </>
  ),
  plan: <path d="M5 6h14M5 12h14M5 18h9" />,
  chart: <path d="M5 20V10M12 20V4M19 20v-7" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  swap: <path d="M7 7h12l-3-3M17 17H5l3 3" />,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16z" />,
  chevron: <path d="M6 9l6 6 6-6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  sparkle: <path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" />,
  cloud: <path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9a4.5 4.5 0 0 0 1 9z" />,
  body: (
    <>
      <circle cx="12" cy="5" r="2.5" />
      <path d="M7 10h10M12 10v5M12 15l-3 6M12 15l3 6" />
    </>
  ),
}

export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Fechar">
            <Icon name="close" />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

export function Field({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: string }) {
  const id = useId()
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <small className="muted">{hint}</small>}
    </div>
  )
}

/** Input que só salva ao sair do campo (blur) ou Enter. */
export function LazyInput({
  id,
  value,
  onCommit,
  type = 'text',
  placeholder,
  inputMode,
  multiline,
}: {
  id?: string
  value: string
  onCommit: (v: string) => void
  type?: string
  placeholder?: string
  inputMode?: 'numeric' | 'decimal' | 'text'
  multiline?: boolean
}) {
  const [v, setV] = useState(value)
  const [prev, setPrev] = useState(value)
  if (value !== prev) {
    setPrev(value)
    setV(value)
  }
  const commit = () => {
    if (v !== value) onCommit(v)
  }
  if (multiline) {
    return (
      <textarea id={id} value={v} placeholder={placeholder} rows={2}
        onChange={(e) => setV(e.target.value)} onBlur={commit} />
    )
  }
  return (
    <input id={id} type={type} value={v} placeholder={placeholder} inputMode={inputMode}
      onChange={(e) => setV(e.target.value)} onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
  )
}


export function CheckButton({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) {
  return (
    <button className={`check ${checked ? 'on' : ''}`} onClick={onToggle} aria-pressed={checked} aria-label={label}>
      <Icon name="check" size={28} />
    </button>
  )
}
