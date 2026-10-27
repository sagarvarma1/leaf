# Deploying Leaf

Leaf is two processes, and they deploy to two kinds of host:

| Part | What it is | Where it runs |
| --- | --- | --- |
| `apps/web` | Next.js app (UI only) | Any Next.js host: **Vercel**, **Orbit**, Netlify, … |
| `apps/server` | REST API, the sync service (saveTransactions + the event WebSocket), SQLite | A **long-running container with a disk**: Fly.io, Railway, Render, a VPS |

The server can't run as serverless functions: it holds live documents in memory, keeps
WebSockets open for minutes, and writes SQLite to a local volume. That's the same reason
real-time products split their stack this way.

```
Browser ── https://leaf.example.com ──▶ Next.js (Vercel / Orbit)
   │                                      └─ /api/* rewritten to ─▶ API server
   └──── wss://api.leaf.example.com ─────────────────────────────▶ API server (container + volume)
```

## 1. The API server

Build from the repo root with the [`Dockerfile`](Dockerfile). It needs a persistent volume at
`/data` (SQLite: records, text instances, history) and listens on port 4000.

- **Fly.io**: [`deploy/fly.toml`](deploy/fly.toml) (commands at the top of the file).
- **A VPS with Caddy**: [`deploy/docker-compose.yml`](deploy/docker-compose.yml) plus the
  site block in [`deploy/Caddyfile`](deploy/Caddyfile).
- **Railway / Render**: create a service from the repo's Dockerfile, attach a volume at
  `/data`, set the variables below, and expose port 4000.

| Variable | Value |
| --- | --- |
| `LEAF_SECRET` | Random string (`openssl rand -hex 32`). Signs WebSocket tickets; keep it stable across restarts. |
| `ANTHROPIC_API_KEY` | Enables Leaf AI (Claude Opus 5.5). Without it the AI button is hidden. `LEAF_AI_MOCK=1` runs the scripted demo model instead. |
| `LEAF_COOKIE_SECURE` | `1` behind HTTPS (the Dockerfile sets it). |
| `LEAF_SEED` | `0` in public deployments (the Dockerfile sets it): visitors get private guest sandboxes instead of shared Alice/Bob accounts. |
| `LEAF_GUEST`, `LEAF_GUEST_TTL_HOURS`, `LEAF_GUESTS_PER_HOUR` | Guest sandboxes: on/off (default on), lifetime (24), per-IP creation limit (10). |
| `LEAF_AI_RUNS_PER_HOUR` | AI runs per user per hour (30). Caps spend on a public demo. |

Check it: `curl https://api.leaf.example.com/api/health`.

## 2. The web app (Vercel or Orbit)

Import the repo and set:

- **Root directory**: `apps/web` (the pnpm workspace at the repo root is installed automatically).
- **Build command**: `next build` (default). **Output**: Next.js (default).
- **Environment variables** (needed at build time, since they're baked into the build):

| Variable | Value |
| --- | --- |
| `LEAF_API_URL` | `https://api.leaf.example.com`. The app proxies `/api/*` there, so the session cookie is first-party. |
| `NEXT_PUBLIC_WS_URL` | `wss://api.leaf.example.com`. Browsers open WebSockets directly to the API server. |

### Why WebSocket tickets

HTTP requests go through the web app's `/api` proxy, so the session cookie lives on the web
app's domain. WebSockets can't be proxied by a serverless host, so they connect straight to
the API server, which is a different site, and the browser won't send the cookie there.
Instead the client fetches a short-lived HMAC-signed ticket (`GET /api/auth/ws-ticket`,
through the proxy) and passes it on the socket URL; it refreshes the ticket before
reconnects. The e2e suite runs in exactly this cross-site setup (page on `localhost`,
sockets on `127.0.0.1`), so every realtime check exercises tickets.

## 3. Scaling notes

One API process serves every document. To scale out, route each page to an owner node
(consistent hashing on the page id, sticky WebSockets), move the workspace event hub to
Redis/NATS pub/sub, and move storage to Postgres. See PLAN.md.
