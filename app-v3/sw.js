const CACHE_NAME = "confirma-v3-cache-v2";
const FILES = [
  "/app-v3",
  "/app-v3/index.html",
  "/app-v3/styles.css",
  "/app-v3/app.js",
  "/app-v3/syncWorker.js",
  "/app-v3/manifest.json",
  "/app/icons/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(FILES.map(async (file) => {
      try {
        await cache.add(file);
      } catch (error) {
        console.warn("[Confirma SW] Failed to cache", file, error);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") {
    event.respondWith(
      caches.match("/app-v3/index.html").then((cached) => cached || fetch(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
