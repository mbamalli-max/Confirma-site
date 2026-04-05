const CACHE_NAME = "confirma-cache-v3";
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
  if (event.request.mode === "navigate") {
    event.respondWith(
      caches.match("/app/index.html").then((cached) => cached || fetch(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
