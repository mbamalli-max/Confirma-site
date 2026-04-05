const CACHE_VERSION = "ajamix-v1";
const SHELL_CACHE = `ajamix-shell-${CACHE_VERSION}`;
const CONTENT_CACHE = `ajamix-content-${CACHE_VERSION}`;
const ASSET_CACHE = `ajamix-assets-${CACHE_VERSION}`;
const KNOWN_CACHES = [SHELL_CACHE, CONTENT_CACHE, ASSET_CACHE];

const SHELL_FILES = [
  "/app/",
  "/app/index.html",
  "/app/styles.css",
  "/app/app.js",
  "/app/quiz-engine.js",
  "/app/manifest.json",
  "/app/fonts/NotoNaskhArabic-Regular.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const requiredShellFiles = SHELL_FILES.filter((filePath) => !/\.woff2$/i.test(filePath));
      const optionalShellFiles = SHELL_FILES.filter((filePath) => /\.woff2$/i.test(filePath));

      await cache.addAll(requiredShellFiles);
      await Promise.allSettled(optionalShellFiles.map((filePath) => cache.add(filePath)));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const oldKeys = keys.filter((key) => key.startsWith("ajamix-") && !KNOWN_CACHES.includes(key));

      await Promise.all(oldKeys.map((key) => caches.delete(key)));
      await self.clients.claim();

      if (oldKeys.length) {
        const clients = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });

        clients.forEach((client) => {
          client.postMessage({
            type: "APP_UPDATE_AVAILABLE",
            cacheVersion: CACHE_VERSION,
          });
        });
      }
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  if (isShellFile(url)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  if (url.pathname.endsWith("/content.json")) {
    event.respondWith(networkFirst(request, CONTENT_CACHE));
    return;
  }

  if (/\.mp3$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  if (/\.(png|jpg|jpeg|webp|svg|gif)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  event.respondWith(networkFirst(request, CONTENT_CACHE));
});

function isShellFile(url) {
  return (
    url.pathname === "/app/" ||
    url.pathname === "/app" ||
    SHELL_FILES.includes(url.pathname)
  );
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);

    if (response && response.ok) {
      cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }

    throw error;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    return cached;
  }

  const response = await fetch(request);

  if (response && response.ok) {
    cache.put(request, response.clone());
  }

  return response;
}
