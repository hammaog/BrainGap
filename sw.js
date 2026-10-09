/* BrainGap.gg Service Worker
 * Ziel: PWA-Installierbarkeit (Google Play / PWABuilder) und ein schlanker Offline-Cache.
 *
 * Strategien
 *  - Seite (index.html, Navigation):  Network-First mit 4 s Zeitlimit, bei Fehler der zuletzt gespeicherte Stand,
 *                                     ganz ohne Cache eine kleine Offline-Seite.
 *  - Eigene Dateien (Icons, Manifest): Stale-While-Revalidate (sofort aus dem Cache, im Hintergrund aktualisiert).
 *  - Skript-Bibliotheken aus dem <head> (React, Babel, Tailwind, Supabase-SDK): Stale-While-Revalidate,
 *    damit die App auch offline startet. Es werden nur genau diese URLs gecacht.
 *  - Alles andere (Supabase-API und Login, Data Dragon, CommunityDragon, ...): wird NIE abgefangen und NIE gecacht.
 *    Die App zeigt für nicht ladbare Bilder ihre eingebauten Platzhalter.
 *
 * Bei Änderungen an der Liste der Skripte im <head> der index.html muss LIB_ASSETS angepasst werden
 * und die VERSION erhöht werden (der Test t37 prüft, dass beides übereinstimmt).
 */
'use strict';

const VERSION = 'v1';
const CORE_CACHE = `braingap-core-${VERSION}`;
const LIB_CACHE = `braingap-libs-${VERSION}`;
const NAV_TIMEOUT_MS = 4000;
const INSTALL_TIMEOUT_MS = 8000;   // ein hängendes CDN darf die Installation nie länger als 8 s aufhalten

// Eigene Dateien (Pfade ab Domain-Wurzel, wie im <head> der index.html und im manifest.json verlinkt)
const CORE_ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png'];
// Externe Skripte aus dem <head> der index.html (exakt dieselben URLs)
const LIB_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.5/babel.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
];
const LIB_HREFS = new Set(LIB_ASSETS.map(u => new URL(u).href));

const OFFLINE_HTML = '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>BrainGap.gg offline</title>'
  + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#010A13;color:#F0E6D2;font-family:system-ui,sans-serif;text-align:center;padding:24px}h1{color:#C89B3C;font-size:22px}</style></head>'
  + '<body><div><h1>Du bist offline</h1><p>BrainGap.gg braucht beim allerersten Start eine Internetverbindung. Danach läuft die App auch ohne Netz weiter.</p><p>Bitte prüfe deine Verbindung und lade die Seite neu.</p></div></body></html>';

// Nur erfolgreiche Antworten (oder undurchsichtige Skript-Antworten) werden gespeichert, nie Fehler und nie "no-store"
const cacheable = res => !!res && (res.ok || res.type === 'opaque') && !/no-store/i.test((res.headers && res.headers.get && res.headers.get('cache-control')) || '');

// Weitergeleitete Antworten dürfen nicht für Navigationen verwendet werden: sauber neu verpacken
async function clean(res) {
  if (!res || !res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function fetchAndPut(cache, request, timeoutMs) {
  const res = await clean(timeoutMs ? await fetchWithTimeout(request, timeoutMs) : await fetch(request));
  if (cacheable(res)) await cache.put(request, res.clone());
  return res;
}

function fetchWithTimeout(request, ms) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, ms);
  return fetch(request, ctrl ? { signal: ctrl.signal } : undefined).finally(() => clearTimeout(timer));
}

const offlinePage = () => new Response(OFFLINE_HTML, { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/html; charset=utf-8' } });

// Seite: Network-First, damit neue Versionen sofort erscheinen; offline der letzte Stand
async function networkFirstPage(request) {
  const cache = await caches.open(CORE_CACHE);
  const path = new URL(request.url).pathname, isIndex = path === '/' || path === '/index.html';
  try {
    const res = await clean(await fetchWithTimeout(request, NAV_TIMEOUT_MS));
    if (res.status >= 500) throw new Error('Serverfehler ' + res.status);
    if (cacheable(res) && isIndex) { await cache.put('/', res.clone()); await cache.put('/index.html', res.clone()); }
    return res;
  } catch (e) {
    return (await cache.match(request, { ignoreSearch: true })) || (await cache.match('/')) || (await cache.match('/index.html')) || offlinePage();
  }
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
    const core = await caches.open(CORE_CACHE), libs = await caches.open(LIB_CACHE);
    // Best effort: ein nicht erreichbares CDN oder eine fehlende Datei darf die Installation nie verhindern
    await Promise.allSettled([
      ...CORE_ASSETS.map(u => fetchAndPut(core, new Request(u, { cache: 'reload' }), INSTALL_TIMEOUT_MS)),
      ...LIB_ASSETS.map(u => fetchAndPut(libs, new Request(u, { mode: 'no-cors' }), INSTALL_TIMEOUT_MS)),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([CORE_CACHE, LIB_CACHE]);
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
    if (url.pathname === '/sw.js') return;                                    // Updates des Service Workers prüft der Browser selbst am Netz
    if (request.mode === 'navigate') { event.respondWith(networkFirstPage(request)); return; }
    event.respondWith(staleWhileRevalidate(event, CORE_CACHE, request));
    return;
  }
  if (LIB_HREFS.has(url.href)) { event.respondWith(staleWhileRevalidate(event, LIB_CACHE, request)); return; }
  // Alles andere (Supabase, Data Dragon, CommunityDragon, ...) bleibt unberührt: direkt ans Netz, nie im Cache
});

self.addEventListener('message', event => { if (event.data === 'SKIP_WAITING') self.skipWaiting(); });
