# syntax=docker/dockerfile:1.7
# Build a Bun standalone executable, then ship it without Bun or node_modules.
ARG BUN_VERSION=1.3.14
ARG ALPINE_VERSION=3.22

FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS builder
WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY build ./build
COPY tests ./tests
RUN bun run typecheck

ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      amd64) target="bun-linux-x64-musl" ;; \
      arm64) target="bun-linux-arm64-musl" ;; \
      *) echo "unsupported target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    mkdir -p dist && \
    bun build --compile --target="${target}" build/entrypoint.ts --outfile dist/beamhop-relay

FROM --platform=$TARGETPLATFORM alpine:${ALPINE_VERSION} AS runtime-files
RUN apk add --no-cache ca-certificates libgcc libstdc++

FROM scratch AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=7777
COPY --from=runtime-files /lib/ld-musl-*.so.1 /lib/
COPY --from=runtime-files /usr/lib/libgcc_s.so.1 /usr/lib/
COPY --from=runtime-files /usr/lib/libstdc++.so.6 /usr/lib/
COPY --from=runtime-files /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /app/dist/beamhop-relay /beamhop-relay
EXPOSE 7777
ENTRYPOINT ["/beamhop-relay"]
