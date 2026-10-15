/* BrainGap.gg Service Worker (Produktions-Build)
 * Ziel: PWA-Installierbarkeit und Offline-Start. Es gibt keine externen Skripte mehr: Programmcode, Stile und
 * Daten liegen als gehashte Dateien unter assets/ auf dem eigenen Server.
 *
 * Strategien
 *  - Seite (index.html, Navigation): Network-First mit 4 s Zeitlimit, bei Fehler der zuletzt gespeicherte Stand,
 *                                    ganz ohne Cache eine kleine Offline-Seite.
 *  - Gehashte Build-Dateien (assets/*): Cache-First. Der Dateiname enthält den Inhalts-Hash, die Datei ändert sich nie.
 *  - Eigene Dateien (Manifest, Icons): Stale-While-Revalidate.
 *  - Alles andere (Supabase-API und Login, Data Dragon, CommunityDragon): wird NIE abgefangen und NIE gecacht.
 *    Die App zeigt für nicht ladbare Bilder ihre eingebauten Platzhalter.
 *
 * Installation: Seite, Manifest und ALLE gehashten Build-Dateien müssen vollständig im Cache landen, sonst bricht die
 * Installation ab und der bisherige Service Worker bleibt aktiv. So entsteht nie ein halber Cache, der offline nicht startet.
 * Die Liste BUILD_ASSETS wird vom Build erzeugt (build.mjs) und stimmt immer mit der index.html überein (Test t37).
 */
'use strict';

const VERSION = 'v23';
const CORE_CACHE = `braingap-core-${VERSION}`;
const ASSET_CACHE = `braingap-assets-${VERSION}`;
const NAV_TIMEOUT_MS = 4000;
const INSTALL_TIMEOUT_MS = 15000;

const SCOPE = (self.registration && self.registration.scope) || (self.location.origin + '/');
const abs = u => new URL(u, SCOPE).href;

// Seite und Manifest (Pflicht beim Installieren)
const PAGE_ASSETS = ['./', 'index.html', 'manifest.json'];
// Icons: schön zu haben, aber eine fehlende Datei verhindert die Installation nicht
const ICON_ASSETS = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];
// Vom Build erzeugt: gehashte Dateien aus der index.html (Pflicht beim Installieren)
const BUILD_ASSETS = [
  "assets/app.055082c46a.css",
  "assets/data.a6c961959d.js",
  "assets/app.3dcdd20bbd.js"
];
const CORE_ASSETS = [...PAGE_ASSETS, ...ICON_ASSETS];
const BUILD_HREFS = new Set(BUILD_ASSETS.map(abs));
const PAGE_PATHS = new Set([new URL('./', SCOPE).pathname, new URL('index.html', SCOPE).pathname]);

const OFFLINE_HTML = '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>BrainGap.gg offline</title>'
  + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#010A13;color:#F0E6D2;font-family:system-ui,sans-serif;text-align:center;padding:24px}h1{color:#C89B3C;font-size:22px}p{max-width:340px;line-height:1.5;color:#CBD5E1}</style></head>'
  + '<body><div><h1>Du bist offline</h1><p>BrainGap.gg braucht beim allerersten Start eine Internetverbindung. Danach läuft die App auch ohne Netz weiter.</p><p>Bitte prüfe deine Verbindung und lade die Seite neu.</p></div></body></html>';

// Nur erfolgreiche Antworten werden gespeichert, nie Fehler und nie "no-store"
const cacheable = res => !!res && res.ok && !/no-store/i.test((res.headers && res.headers.get && res.headers.get('cache-control')) || '');

// Weitergeleitete Antworten dürfen nicht für Navigationen verwendet werden: sauber neu verpacken
async function clean(res) {
  if (!res || !res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

function fetchWithTimeout(request, ms) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, ms);
  return fetch(request, ctrl ? { signal: ctrl.signal } : undefined).finally(() => clearTimeout(timer));
}

async function fetchAndPut(cache, request, timeoutMs, key) {
  const res = await clean(timeoutMs ? await fetchWithTimeout(request, timeoutMs) : await fetch(request));
  if (!cacheable(res)) throw new Error('nicht cachebar: ' + (res && res.status));
  await cache.put(key || request, res.clone());
  return res;
}

const offlinePage = () => new Response(OFFLINE_HTML, { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/html; charset=utf-8' } });

// Seite: Network-First, damit neue Versionen sofort erscheinen; offline der letzte Stand
async function networkFirstPage(request) {
  const cache = await caches.open(CORE_CACHE);
  const path = new URL(request.url).pathname, isIndex = PAGE_PATHS.has(path);
  try {
    const res = await clean(await fetchWithTimeout(request, NAV_TIMEOUT_MS));
    if (res.status >= 500) throw new Error('Serverfehler ' + res.status);
    if (cacheable(res) && isIndex) { await cache.put(abs('./'), res.clone()); await cache.put(abs('index.html'), res.clone()); }
    return res;
  } catch (e) {
    return (await cache.match(request, { ignoreSearch: true })) || (await cache.match(abs('./'))) || (await cache.match(abs('index.html'))) || offlinePage();
  }
}

// Gehashte Build-Dateien: Cache-First (der Name enthält den Hash)
async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await clean(await fetch(request));
  if (cacheable(res)) await cache.put(request, res.clone());
  return res;
}

// Sofort aus dem Cache, im Hintergrund aktualisieren; ohne Cache direkt vom Netz
async function staleWhileRevalidate(event, cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const update = fetch(request).then(async res => { const r = await clean(res); if (cacheable(r)) await cache.put(request, r.clone()); return r; }).catch(() => null);
  if (cached) { event.waitUntil(update); return cached; }
  return (await update) || new Response('', { status: 504, statusText: 'Offline' });
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const core = await caches.open(CORE_CACHE), assets = await caches.open(ASSET_CACHE);
    // Pflicht: Seite, Manifest und alle Build-Dateien. Schlägt eine fehl, bricht die Installation ab (alter Stand bleibt aktiv).
    await Promise.all([
      ...PAGE_ASSETS.map(u => fetchAndPut(core, new Request(abs(u), { cache: 'reload' }), INSTALL_TIMEOUT_MS)),
      ...BUILD_ASSETS.map(u => fetchAndPut(assets, new Request(abs(u), { cache: 'reload' }), INSTALL_TIMEOUT_MS)),
    ]);
    // Best effort: Icons
    await Promise.allSettled(ICON_ASSETS.map(u => fetchAndPut(core, new Request(abs(u), { cache: 'reload' }), INSTALL_TIMEOUT_MS)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([CORE_CACHE, ASSET_CACHE]);
    for (const k of await caches.keys()) if (k.startsWith('braingap-') && !keep.has(k)) await caches.delete(k);   // nur eigene alte Caches
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || (request.headers && request.headers.has && request.headers.has('range'))) return;
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  if (url.origin === self.location.origin) {
    if (url.pathname === new URL('sw.js', SCOPE).pathname) return;            // Updates des Service Workers prüft der Browser selbst am Netz
    if (request.mode === 'navigate') { event.respondWith(networkFirstPage(request)); return; }
    if (BUILD_HREFS.has(url.href)) { event.respondWith(cacheFirst(ASSET_CACHE, request)); return; }
    event.respondWith(staleWhileRevalidate(event, CORE_CACHE, request));
    return;
  }
  // Alles andere (Supabase, Data Dragon, CommunityDragon) bleibt unberührt: direkt ans Netz, nie im Cache
});

self.addEventListener('message', event => { if (event.data === 'SKIP_WAITING') self.skipWaiting(); });
