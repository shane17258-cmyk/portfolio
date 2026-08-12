/* GlintPortfolio - Service Worker */

const CACHE_VERSION = 'v8';
const CACHE_NAME = `glint-portfolio-${CACHE_VERSION}`;

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './styles.css?v=8',
  './app.js?v=8',
  './data.js?v=8',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  'https://cdn.jsdelivr.net/npm/chart.js'
];

// Hosts that must always hit the network (live price APIs)
const NETWORK_ONLY_HOSTS = [
  'mis.twse.com.tw',
  'corsproxy.io',
  'allorigins.win'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.allSettled(
        PRECACHE_ASSETS.map((url) => cache.add(url))
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

  // Navigation (HTML pages): network-first with cache fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Static assets: stale-while-revalidate
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
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
