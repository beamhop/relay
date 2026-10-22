# beamhop — Nostr relay + Blossom media server + admin panel
# Build:  docker build -t beamhop .
# Run:    docker run -p 3334:3334 -v beamhop-data:/data -e BEAMHOP_OWNERS=npub1... beamhop
ARG BUN_VERSION=1.4.3

# ---------------------------------------------------------------- build: install everything, build admin UI + plugin UIs
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run build:ui && bun run build:plugins

# ---------------------------------------------------------------- prod deps only
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production --ignore-scripts

# ---------------------------------------------------------------- runtime
FROM oven/bun:${BUN_VERSION}-slim AS runtime
LABEL org.opencontainers.image.title="beamhop" \
      org.opencontainers.image.description="Nostr relay + Blossom media server + PWA admin panel + plugins" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    BEAMHOP_HOST=0.0.0.0 \
    BEAMHOP_PORT=3334 \
    BEAMHOP_SQLITE_PATH=/data/beamhop.db \
    BEAMHOP_BLOSSOM_FS_PATH=/data/blobs \
    BEAMHOP_PLUGINS_DIR=/app/plugins \
    BEAMHOP_ADMIN_UI_DIR=/app/packages/admin-ui/dist
WORKDIR /app
COPY --from=deps --chown=bun:bun /app /app
COPY --from=build --chown=bun:bun /app/packages/admin-ui/dist /app/packages/admin-ui/dist
COPY --from=build --chown=bun:bun /app/plugins /app/plugins
RUN mkdir -p /data && chown -R bun:bun /data
USER bun
VOLUME ["/data"]
EXPOSE 3334
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.BEAMHOP_PORT||3334)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["bun", "packages/server/src/cli.ts"]
CMD ["start"]
