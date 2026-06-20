# syntax=docker/dockerfile:1.7
# beamhop relay image (ADR-0005), mirroring the music-manager tenant: oven/bun, manifests first
# for a cached dependency layer, then the source, run directly with no separate build step.
# linux/amd64 only (matches the Hetzner amd64 node). Keep BUN_VERSION synced with bun.lock.
ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:${BUN_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=7777
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 7777
CMD ["bun", "run", "src/main.ts"]
