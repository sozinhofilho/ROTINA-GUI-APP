import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import { bootstrapToken, getToken, setMemoryToken } from './lib/api.ts'
import { installDemo } from './demo.ts'
import App from './App.tsx'

if (import.meta.env.MODE === 'demo') {
  // Demonstração: "servidor" falso no navegador, sem login e sem service worker.
  installDemo()
  bootstrapToken()
  if (!getToken()) setMemoryToken('demo')
} else {
  bootstrapToken()
  registerSW({ immediate: true })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
