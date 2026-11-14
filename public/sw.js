// OMNI offline shell. Keeps the dashboard openable when the tablet loses the
// station Wi-Fi or the web container restarts. API traffic (/rest, /auth,
// /realtime) is never cached here: live data and its offline copy are owned
// by the app's IndexedDB layer.
const CACHE = "omni-shell-v1";
const PAGES = ["/dashboard"];

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

function isApi(url) {
  return /^\/(rest|auth|realtime)\/v1\//.test(url.pathname) || url.pathname.startsWith("/api/");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isApi(url)) return;

  // Immutable build assets: cache first.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              void caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Pages: network first, fall back to the last good copy.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(request);
          if (res.ok && PAGES.includes(url.pathname)) {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put(url.pathname, copy));
          }
          return res;
        } catch {
          const cached = await caches.match(url.pathname);
          if (cached) return cached;
          const fallback = await caches.match("/dashboard");
          return (
            fallback ||
            new Response("<h1>OMNI offline</h1><p>Reconnect to the station network.</p>", {
              status: 503,
              headers: { "content-type": "text/html" },
            })
          );
        }
      })(),
    );
  }
});
