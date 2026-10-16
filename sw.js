const CACHE = "thrift-scout-v11";
const ASSETS = ["./", "index.html", "styles.css", "app.js", "manifest.json", "icon.svg"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS))));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))));
self.addEventListener("fetch", (e) => {
  if (new URL(e.request.url).origin !== location.origin) return;
  if (new URL(e.request.url).pathname.startsWith("/api/")) {
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
