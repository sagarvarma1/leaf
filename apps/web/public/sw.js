/*
 * Leaf's service worker: the offline app shell.
 *
 * Page contents never come from here. They live in Yjs documents replicated to IndexedDB
 * (lib/collab.ts, lib/offline.ts), which merge with the server on reconnect. This worker
 * only makes the *app* load without a network: HTML, scripts, styles, and the read-only
 * API responses the shell needs (session, page tree, page metadata).
 *
 * Strategy: network-first for every same-origin GET, falling back to the last good copy.
 * Online behaviour is therefore unchanged (no stale UI after a deploy, works with
 * `next dev`); the cache only answers when the network can't.
 */
const CACHE = "leaf-v1";
const MAX_ENTRIES = 600;
// Never cache: tickets are short-lived credentials; exports/uploads are large and live.
const SKIP = [/^\/api\/auth\/(ws-ticket|logout|login|guest|join)/, /^\/api\/pages\/[^/]+\/export/, /^\/api\/uploads/, /^\/_next\/webpack-hmr/];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

function cacheable(req) {
  if (req.method !== "GET") return false;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return false;
  if (req.headers.has("x-leaf-share")) return false; // share-link guests stay online-only
  return !SKIP.some((re) => re.test(url.pathname));
}

async function put(req, res) {
  if (!res.ok || res.type === "opaque") return;
  const cache = await caches.open(CACHE);
  await cache.put(req, res);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(k);
}

const OFFLINE_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline · Leaf</title>
<style>body{font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#37352f;background:#fff}@media(prefers-color-scheme:dark){body{background:#191919;color:#e6e6e5}}div{max-width:360px;text-align:center}a{color:inherit}</style>
<div><p style="font-size:40px;margin:0">🌿</p><p><strong>You're offline.</strong><br>This page hasn't been saved on this device yet.</p><p><a href="javascript:history.back()">Go back</a></p></div>`;

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (!cacheable(req)) return;
  e.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        e.waitUntil(put(req, res.clone()));
        return res;
      } catch (err) {
        // Build assets: content-hashed in production, cache-busted with ?v= in dev, so the
        // path alone identifies them. Navigations: ignore Vary (RSC headers) for documents.
        const url = new URL(req.url);
        const hit = await caches.match(req, { ignoreSearch: url.pathname.startsWith("/_next/static/"), ignoreVary: req.mode === "navigate" });
        if (hit) return hit;
        if (req.mode === "navigate") return new Response(OFFLINE_HTML, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
        throw err;
      }
    })(),
  );
});

self.addEventListener("message", (e) => {
  const msg = e.data || {};
  // Resources the page loaded before this worker controlled it, plus pages to keep warm.
  if (msg.type === "cache") {
    e.waitUntil(
      Promise.all(
        (msg.urls || []).filter((u) => cacheable(new Request(u, { credentials: "same-origin" }))).map((u) =>
          fetch(u, { credentials: "same-origin" })
            .then((res) => put(new Request(u), res))
            .catch(() => {}),
        ),
      ),
    );
  }
  if (msg.type === "clear") e.waitUntil(caches.delete(CACHE));
});
