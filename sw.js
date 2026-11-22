'use strict';

const cacheName = 'spektr-shell-v2';
const shell = ['/', '/index.html', '/app.js', '/styles.css', '/hero.webp', '/icon.png', '/icon-large.png', '/manifest.webmanifest',
  '/event-ink.webp', '/event-sun.webp', '/event-lilac.webp'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('spektr-shell-') && key !== cacheName)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || !shell.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      void caches.open(cacheName).then(cache => cache.put(url.pathname, copy)).catch(() => {});
    }
    return response;
  }).catch(() => caches.match(url.pathname)));
});
