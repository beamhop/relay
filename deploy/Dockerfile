# SPDX-License-Identifier: AGPL-3.0-or-later
# Beamhop single-binary image. Build from the repo root:
#   docker build -f deploy/Dockerfile -t beamhop .
# Multi-arch: docker buildx build --platform linux/amd64,linux/arm64 -f deploy/Dockerfile .
# If packages/pwa/build exists in the build context, the admin app is embedded.

ARG BUN_VERSION=1.4.3

FROM oven/bun:${BUN_VERSION} AS build
# Set by the release workflow (tag name); embedded as the binary's version once runtime-bun
# reads it at build time.
ARG BEAMHOP_BUILD_VERSION=dev
WORKDIR /src
COPY package.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN bun install
RUN BEAMHOP_BUILD_VERSION="${BEAMHOP_BUILD_VERSION#v}" \
    bun packages/runtime-bun/scripts/build.ts --host --outdir /out \
 && mv /out/beamhop-linux-* /out/beamhop \
 && mkdir -p /data-empty

FROM gcr.io/distroless/cc-debian12:nonroot
LABEL org.opencontainers.image.title="Beamhop" \
      org.opencontainers.image.description="Nostr relay + Blossom media server" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.source="https://github.com/beamhop/beamhop"
COPY --from=build /out/beamhop /usr/local/bin/beamhop
COPY --from=build --chown=65532:65532 /data-empty /data
ENV BEAMHOP_DATA_DIR=/data \
    BEAMHOP_LISTEN=0.0.0.0:3334
USER 65532:65532
VOLUME ["/data"]
EXPOSE 3334
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/beamhop", "--healthcheck"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/beamhop"]
