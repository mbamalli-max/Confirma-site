const CACHE_NAME = "confirma-v2-cache";
const FILES = [
  "/app-v2",
  "/app-v2/index.html",
  "/app-v2/styles.css",
  "/app-v2/app.js",
  "/app-v2/manifest.json",
  "/app/icons/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
