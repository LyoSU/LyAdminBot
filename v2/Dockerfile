# LyAdminBot v2 — production image.
#
# Runs the exact same execution path as development (tsx over TS sources,
# workspace packages export ./src) — zero build-step drift between what was
# tested and what runs in production.
#
# Coolify: base directory = v2, Dockerfile build pack.
# Required env: API_ID, API_HASH, BOT_TOKEN, MONGODB_URI
# Optional env: OPENAI_API_KEY, OPENROUTER_API_KEY, QDRANT_URL, QDRANT_API_KEY,
#               LLM_CHEAP_MODEL, LLM_STRONG_MODEL
# Persistent volume: /data (mtcute session — MUST survive redeploys,
# otherwise the bot re-authorizes on every deploy).

FROM node:22-bookworm-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && mkdir -p /data
WORKDIR /app

# Manifests first: dependency layer survives source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/
COPY packages/data/package.json packages/data/
COPY packages/ui/package.json packages/ui/
COPY apps/bot/package.json apps/bot/
COPY tools/replay/package.json tools/replay/
RUN pnpm install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
ENV SESSION_PATH=/data/session

WORKDIR /app/apps/bot
# node --import tsx = single process, signals reach the shutdown handlers.
CMD ["node", "--import", "tsx", "src/main.ts"]
