const CACHE_NAME = "happypaint-static-v9";
const STATIC_ASSETS = [
  "/linen.png",
  "/canvas.png",
  "/brand-mark.svg",
  "/icon-192.png",
  "/icon-512.png",
];

// Cache the entry dependencies before replacing the offline shell. This also
// handles future builds where the JS hashes change but this worker does not.
async function cacheShell(shell) {
    if (!shell.ok || !shell.headers.get("content-type")?.includes("text/html")) return;
    const cache = await caches.open(CACHE_NAME);
    const html = await shell.clone().text();
    const entryAssets = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+\.(?:js|css))["']/g)].map((match) => match[1]);
    const missing = [];
    for (const path of new Set([...STATIC_ASSETS, ...entryAssets])) {
      if (!(await cache.match(path))) missing.push(path);
    }
    if (missing.length) await cache.addAll(missing);
    await cache.put("/index.html", shell);
}

// Installation happens after the entry scripts loaded. Cache their URLs from
// the built shell; lazy studio/tools are cached only once visited.
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const shell = await fetch("/index.html", { cache: "reload" });
    if (!shell.ok) throw new Error("App shell unavailable");
    await cacheShell(shell);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("happypaint-static-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  // Never store third-party scripts, ads, or account responses in this cache.
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/src/") || url.pathname.startsWith("/@vite") || url.pathname.includes("node_modules")) {
    return;
  }

  // NEVER cache or intercept live endpoints — the API and websocket must always
  // hit the network (caching the API was returning stale/empty saved-art lists).
  // robots/sitemap are server-generated with their own HTTP caching; the SW's
  // forever-cache would pin them stale across deploys.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/ws") ||
    url.pathname === "/robots.txt" ||
    url.pathname === "/sitemap.xml"
  ) {
    return;
  }

  // App shell / navigations: network-first so new builds load without a hard
  // refresh, falling back to cache when offline.
  if (request.mode === "navigate") {
    const network = fetch(request);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      event.waitUntil(network.then((response) => cacheShell(response.clone())).catch(() => {}));
    }
    event.respondWith(network.catch(async () => {
      const shell = await caches.match("/index.html");
      return shell || new Response("Open Drawesome while online first, then return to a canvas you’ve visited.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }));
    return;
  }

  // Big long-lived assets already served with far-future HTTP cache headers —
  // don't double-store them in the SW cache (the worker alone is multi-MB).
  if (!url.pathname.startsWith("/assets/") && !STATIC_ASSETS.includes(url.pathname)) return;
  if (/\/(?:nsfwWatcher\.worker|mobilenet|model\.min|group1-shard|dist-)/.test(url.pathname)) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(request).then(async (response) => {
        if (response.ok && response.type === "basic") {
          const cache = await caches.open(CACHE_NAME);
          // Quota exhaustion must not break a successful online request.
          await cache.put(request, response.clone()).catch(() => {});
        }
        return response;
      });
    }),
  );
});
