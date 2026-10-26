# The Leaf API + realtime server (REST, WebSockets, SQLite). Long-running, stateful:
# deploy it on a container host with a persistent volume at /data (Fly.io, Railway,
# Render, a VPS). The Next.js web app deploys separately (Vercel, Orbit, ...).
FROM node:22-slim

WORKDIR /app
RUN corepack enable

# Dependencies first, for layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter "@leaf/server..."

COPY packages/shared packages/shared
COPY apps/server apps/server

ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    LEAF_DATA_DIR=/data \
    API_PORT=4000 \
    LEAF_SEED=0 \
    LEAF_COOKIE_SECURE=1
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@leaf/server", "start"]
