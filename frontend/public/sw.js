const CACHE_NAME = 'counterline-shell-v3'
const SHELL_ASSETS = ['/manifest.webmanifest', '/brand-icon.svg', '/favicon-32.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(['/', ...SHELL_ASSETS])))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('counterline-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return

  const fetchAndCache = async () => {
    const response = await fetch(request)
    if (response.ok) {
      const copy = response.clone()
      event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined))
    }
    return response
  }

  if (request.mode === 'navigate') {
    const page = url.pathname === '/' && !url.search ? fetchAndCache() : fetch(request)
    event.respondWith(page.catch(async () => (await caches.match('/')) || Response.error()))
    return
  }

  if (url.pathname.startsWith('/assets/') || SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetchAndCache()))
  }
})
