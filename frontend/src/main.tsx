import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((registration) => {
      const announceUpdate = () => window.dispatchEvent(new Event('counterline:update-available'))
      if (registration.waiting && navigator.serviceWorker.controller) announceUpdate()
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) announceUpdate()
        })
      })
    }).catch(() => undefined)
  })
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload())
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
