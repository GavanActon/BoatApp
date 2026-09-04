// The push half of the service worker, pulled in by the generated one
// (vite.config.ts → workbox.importScripts). A notification is a title
// ("Aaron · Whaler") and a fact ("departed for The Sandies · about 1:40");
// tapping it opens the app on the Crew sheet.
self.addEventListener('push', (event) => {
  let d = {}
  try {
    d = event.data ? event.data.json() : {}
  } catch {
    /* not ours */
  }
  const title = d.title || 'Sandies'
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, {
        body: d.body || '',
        tag: d.tag || undefined,
        renotify: !!d.tag,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: { url: d.url || '/#crew' },
      }),
      // an open app hears the moment too, and asks the server at once
      // rather than waiting for its minute
      self.clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then((clients) => clients.forEach((c) => c.postMessage({ type: 'crew-news' }))),
    ]),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/#crew'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ('focus' in c) {
          c.postMessage({ type: 'open', tab: 'crew' })
          return c.focus()
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
