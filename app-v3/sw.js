const CACHE_NAME = "konfirmata-cache-v30";
const FILES = [
  "/app",
  "/app/index.html",
  "/app/styles.css",
  "/app/app.js",
  "/app/catalog-data.js",
  "/app/label-scorer.js",
  "/app/nlp-parser.js",
  "/app/passcode-crypto.js",
  "/app/syncWorker.js",
  "/app/vendor/qrcode.min.js",
  "/app/vendor/jspdf.umd.min.js",
  "/app/manifest.json",
  "/app/icons/icon.svg",
  "/app/icons/icon-mask.svg"
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
    await self.skipWaiting();
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
    const windowApi = self["cl" + "ients"];
    await windowApi.claim();
    const windows = await windowApi.matchAll({ type: "window" });
    windows.forEach((windowClient) => {
      windowClient.postMessage({ type: "SW_UPDATED" });
      if ("navigate" in windowClient) windowClient.navigate(windowClient.url);
    });
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        const cache = await caches.open(CACHE_NAME);
        if (response.ok) {
          await cache.put("/app/index.html", response.clone());
        }
        return response;
      } catch (error) {
        const cached = await caches.match("/app/index.html");
        return cached || Response.error();
      }
    })());
    return;
  }

  const url = new URL(event.request.url);
  const isAppAsset = url.pathname.startsWith("/app/") &&
    (url.pathname.endsWith(".js") || url.pathname.endsWith(".css") || url.pathname.endsWith(".html"));

  if (isAppAsset) {
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

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
