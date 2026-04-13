const CACHE_NAME = "confirma-cache-v4";
const FILES = [
  "/app",
  "/app/index.html",
  "/app/styles.css",
  "/app/app.js",
  "/app/syncWorker.js",
  "/app/manifest.json",
  "/app/icons/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(FILES.map(async (file) => {
      try {
        await cache.add(file);
      } catch (error) {
        console.warn("[Konfirmata SW] Failed to cache", file, error);
      }
    }));
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
    const clients = await self.clients.matchAll();
    clients.forEach((client) => client.postMessage({ type: "SW_UPDATED" }));
  })());
});

self.addEventListener("fetch", (event) => {
  // Navigation requests: serve cached index.html
  if (event.request.mode === "navigate") {
    event.respondWith(
      caches.match("/app/index.html").then((cached) => cached || fetch(event.request))
    );
    return;
  }

  const url = new URL(event.request.url);
  const isAppAsset = url.pathname.startsWith("/app/") &&
    (url.pathname.endsWith(".js") || url.pathname.endsWith(".css") || url.pathname.endsWith(".html"));

  if (isAppAsset) {
    // Stale-while-revalidate: serve cache immediately, update in background
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(event.request).then((cached) => {
          const fetchPromise = fetch(event.request).then((response) => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          }).catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // Everything else: cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
