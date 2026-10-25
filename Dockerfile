# beamhop — Nostr relay + Blossom media server + admin panel
# Build:  docker build -t beamhop .
# Run:    docker run -p 3334:3334 -v beamhop-data:/data -e BEAMHOP_OWNERS=npub1... beamhop
ARG BUN_VERSION=1.4.3

# ---------------------------------------------------------------- manifests: package.json files + bun.lock only, so
# the install layers below stay cached until a dependency actually changes (new workspaces are picked up automatically)
FROM oven/bun:${BUN_VERSION} AS manifests
WORKDIR /app
COPY . .
RUN find . -type f ! -name package.json ! -name bun.lock -delete && find . -type d -empty -delete

# ---------------------------------------------------------------- build: install everything, build admin UI + plugin UIs
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY --from=manifests /app ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun run build:ui && bun run build:plugins

# ---------------------------------------------------------------- prod deps only (admin-ui deps are all devDependencies: Vite bundles them)
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY --from=manifests /app ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# ---------------------------------------------------------------- app: the tree the runtime ships, assembled here so the
# runtime gets it as one layer. Dev node_modules are swapped for the production ones; of the admin UI only the built
# dist/ (and the package.json its workspace link points at) is kept. Tests, e2e and docs never enter the build context.
FROM build AS app
RUN rm -rf node_modules packages/*/node_modules plugins/*/node_modules e2e/node_modules \
 && find packages/admin-ui -mindepth 1 -maxdepth 1 ! -name dist ! -name package.json -exec rm -rf {} +
COPY --from=deps /app ./
# code (incl. the auto-imported plugins dir) stays root-owned and read-only for the runtime user, so a file-write bug
# can't turn into persistent code execution; only /data is writable
RUN chmod -R go-w /app

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
COPY --from=app /app /app
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME ["/data"]
EXPOSE 3334
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.BEAMHOP_PORT||3334)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["bun", "packages/server/src/cli.ts"]
CMD ["start"]
