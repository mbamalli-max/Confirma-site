const CACHE_NAME = "konfirmata-cache-v48";
const FILES = [
  "/app",
  "/app/index.html",
  "/app/styles.css",
  "/app/app.js",
  "/app/quick-transactions.js",
  "/app/recovery-core.js",
  "/app/recovery-client.js",
  "/app/catalog-data.js",
  "/app/business-search.js",
  "/app/business-text.js",
  "/app/business-aliases.js",
  "/app/label-scorer.js",
  "/app/nlp-parser.js",
  "/app/passcode-crypto.js",
  "/app/syncWorker.js",
  "/app/vendor/qrcode.min.js",
  "/app/vendor/jspdf.umd.min.js",
  "/app/vendor/chart.umd.js",
  "/app/manifest.json",
  "/app/icons/icon.svg",
  "/app/icons/icon-mask.svg",
  "/app/icons/icon-192.png",
  "/app/icons/icon-512.png",
  "/app/icons/icon-maskable-512.png",
  "/app/icons/apple-touch-icon-180.png"
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
    // An older Konfirmata cache is a signal for this release, not definitive proof of a prior install.
    const isUpgrade = keys.some((key) => key !== CACHE_NAME && key.startsWith("konfirmata-cache-"));
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    const windowApi = self["cl" + "ients"];
    await windowApi.claim();
    if (!isUpgrade) return;
    const windows = await windowApi.matchAll({ type: "window" });
    windows.forEach((windowClient) => {
      const path = new URL(windowClient.url).pathname;
      if (path !== "/app" && !path.startsWith("/app/")) return;
      windowClient.postMessage({ type: "SW_UPDATED" });
      if ("navigate" in windowClient) windowClient.navigate(windowClient.url);
    });
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname !== "/app" && !url.pathname.startsWith("/app/")) return;

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
