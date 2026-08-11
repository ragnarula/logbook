// Offline shell.
//
// The app's own data lives in IndexedDB and syncs itself, so this only has to
// guarantee that the code is on the device when the network is not. Everything
// is served network-first with the cache as a timeout and offline fallback —
// the cache must never decide which version of the code runs.

// Bump on every shipped change to the static assets.
const VERSION = "tracker-v25";

// How long to wait for the network before falling back to cache. Long enough
// that a normal connection always wins, short enough that a dead one does not
// leave you staring at a blank screen at 3am.
const NETWORK_TIMEOUT_MS = 3000;

// Module URLs carry the release, matching what index.html asks for. Caching
// the bare paths would store copies the page never requests.
const V = `?v=${VERSION}`;

const ASSETS = [
  "/",
  "/static/index.html",
  "/static/style.css",
  `/static/app.js${V}`,
  `/static/ui.js${V}`,
  `/static/store.js${V}`,
  `/static/sync.js${V}`,
  "/manifest.webmanifest",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
  "/static/icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Sync and export must always be live.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/").then((r) => r || caches.match("/static/index.html")))
    );
    return;
  }

  // Network-first, with the cache as a timeout and offline fallback.
  //
  // Cache-first was wrong here and shipped a real bug: a device kept serving
  // the old CSS and JS after a fix was deployed, so the app stayed broken with
  // no way for the user to tell. The app's data lives in IndexedDB and syncs on
  // its own, so the cache only needs to cover being offline — never to decide
  // which version of the code runs.
  event.respondWith(
    new Promise((resolve) => {
      let settled = false;
      const fromCache = () =>
        caches.match(request).then((cached) => {
          if (!settled && cached) {
            settled = true;
            resolve(cached);
          }
          return cached;
        });

      const timer = setTimeout(fromCache, NETWORK_TIMEOUT_MS);

      fetch(request)
        .then((response) => {
          clearTimeout(timer);
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          if (!settled) {
            settled = true;
            resolve(response);
          }
        })
        .catch(async () => {
          clearTimeout(timer);
          const cached = await fromCache();
          if (!settled) {
            settled = true;
            resolve(cached || Response.error());
          }
        });
    })
  );
});
