const CACHE = 'film-lab-v5';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png',
  './assets/cam-classic.svg', './assets/cam-golden.svg', './assets/cam-cool.svg', './assets/cam-faded.svg', './assets/cam-mono.svg', './assets/sample.jpg'];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())));
// 이전 버전 캐시를 지우고 열려 있는 페이지를 바로 인계받는다
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
// 네트워크 우선, 오프라인이면 캐시 사용
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => {
    if (r.ok && new URL(e.request.url).origin === self.location.origin) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request)));
});
