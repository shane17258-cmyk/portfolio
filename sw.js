/* GlintPortfolio - Service Worker */

const CACHE_VERSION = 'v18';
const CACHE_NAME = `glint-portfolio-${CACHE_VERSION}`;

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './styles.css?v=18',
  './app.js?v=18',
  './data.js?v=18',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  'https://cdn.jsdelivr.net/npm/chart.js'
];

// Hosts that must always hit the network (live price / FX APIs)
const NETWORK_ONLY_HOSTS = [
  'mis.twse.com.tw',
  'corsproxy.io',
  'allorigins.win',
  'bot.com.tw',
  'stooq.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.allSettled(
        // cache:'reload' bypasses the browser HTTP cache so fresh files are cached
        PRECACHE_ASSETS.map((url) => cache.add(new Request(url, { cache: 'reload' })))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Live price API calls: never cache, let browser handle network
  const isNetworkOnly = NETWORK_ONLY_HOSTS.some((host) => url.hostname.includes(host));
  if (isNetworkOnly) return;

  // Navigation (HTML pages): network-first with cache fallback (bypass HTTP cache)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(new Request(request.url, { cache: 'reload' }))
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Static assets: stale-while-revalidate (network bypasses HTTP cache)
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(new Request(request.url, { cache: 'reload', mode: request.mode, credentials: request.credentials, redirect: request.redirect }))
        .then((response) => {
          if (response && (response.ok || response.type === 'opaque')) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
