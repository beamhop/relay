# SPDX-License-Identifier: AGPL-3.0-or-later
# Beamhop single-binary image. Build from the repo root:
#   docker build -f deploy/Dockerfile -t beamhop .
# Multi-arch: docker buildx build --platform linux/amd64,linux/arm64 -f deploy/Dockerfile .
# If packages/pwa/build (admin app) or packages/team-client/build (Team app) exist in
# the build context, they are embedded.
#
# Image processing: sharp (native addon + libvips) cannot live inside the single
# binary. `bun install` installs it for the build platform (optional dependency of
# @beamhop/media) and `--with-sharp` copies it to /out/<target>/node_modules, which is
# shipped next to the binary; the binary loads it from there (or BEAMHOP_SHARP_PATH).
# Without it uploads are stored unchanged.

ARG BUN_VERSION=1.4.3

FROM oven/bun:${BUN_VERSION} AS build
# Set by the release workflow (tag name); embedded as the binary's version once runtime-bun
# reads it at build time.
ARG BEAMHOP_BUILD_VERSION=dev
WORKDIR /src
COPY package.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN bun install
# sharp (optional dependency of @beamhop/media) must be installed with its glibc
# prebuilt for this platform; fail the image build early if it cannot load.
RUN cd packages/media && bun -e "await import('sharp')"
RUN BEAMHOP_VERSION="${BEAMHOP_BUILD_VERSION#v}" \
    bun packages/runtime-bun/scripts/build.ts --host --with-sharp --outdir /out \
 && mv /out/linux-* /out/pkg \
 && mkdir -p /out/pkg/node_modules /data-empty

FROM gcr.io/distroless/cc-debian12:nonroot
LABEL org.opencontainers.image.title="Beamhop" \
      org.opencontainers.image.description="Nostr relay + Blossom media server" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.source="https://github.com/beamhop/beamhop"
COPY --from=build /out/pkg/beamhop /usr/local/bin/beamhop
COPY --from=build /out/pkg/node_modules /usr/local/bin/node_modules
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
