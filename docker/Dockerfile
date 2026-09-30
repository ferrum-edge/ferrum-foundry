# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# Keep the build and runtime on the same active LTS Node.js major (24 until
# Node 26 enters LTS). Both multi-platform base indexes are digest-pinned so
# release provenance identifies the base images (until #504 the runtime also
# fetches pinned OpenSSL packages at build time); move both majors together.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.ts tsconfig.json tsconfig.server.json vite-env.d.ts ./
COPY public ./public
COPY src ./src
COPY server ./server
COPY shared ./shared

RUN npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force

# TODO(#504): return the runtime to gcr.io/distroless/nodejs24-debian13:nonroot
# once upstream publishes a digest whose libssl3t64 carries the Debian 13 fix
# for CVE-2026-75804 and CVE-2026-84782. Until then the runtime is the Debian 13
# Node slim image with the Node package managers removed, running as UID/GID
# 65532 with Node itself as the entrypoint. It is not distroless: a shell and
# apt/dpkg remain (dpkg's status data also lets the scanner see OS packages).
#
# Node is exposed at /nodejs/bin/node, the distroless path, so the entrypoint,
# the HEALTHCHECK, and the deployment starter's demo-backend probe work
# unchanged on this image, on already-published distroless images, and after
# #504 (scripts/starter-preflight.test.mjs).
FROM node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe

# - Upgrade only the OpenSSL packages, pinned to the fixed 3.5.7-1~deb13u3, so
#   the build fails loudly if the security feed no longer offers exactly that
#   version. Drop this step once the pinned base carries it.
# - Remove npm, npx, corepack, and yarn: the runtime never installs Node
#   packages, and npm's bundled dependencies carry their own scanner findings.
# - Link /nodejs/bin/node to the image's Node.
# - Create the distroless-equivalent nonroot user with a numeric UID, so
#   Kubernetes `runAsNonRoot` can verify it.
RUN apt-get update \
  && apt-get install --no-install-recommends --only-upgrade --yes \
    libssl3t64=3.5.7-1~deb13u3 openssl-provider-legacy=3.5.7-1~deb13u3 \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules /usr/local/include/node /usr/local/share/doc/node \
    /opt/yarn-v* \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/docker-entrypoint.sh \
  && for tool in npm npx corepack yarn yarnpkg; do \
    if command -v "$tool" >/dev/null; then echo "$tool is still installed" >&2; exit 1; fi; \
  done \
  && mkdir -p /nodejs/bin \
  && ln -s /usr/local/bin/node /nodejs/bin/node \
  && groupadd --system --gid 65532 nonroot \
  && useradd --system --uid 65532 --gid nonroot --no-log-init \
    --home-dir /home/nonroot --create-home --shell /usr/sbin/nologin nonroot

WORKDIR /app

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/ferrum-edge/ferrum-foundry" \
  org.opencontainers.image.revision="$SOURCE_REVISION"

COPY --from=builder --chown=65532:65532 /app/dist ./dist
COPY --from=builder --chown=65532:65532 /app/dist-server ./dist-server
COPY --from=builder --chown=65532:65532 /app/shared/admin-jwt.js ./shared/admin-jwt.js
COPY --from=builder --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=builder --chown=65532:65532 /app/package.json ./

ENV NODE_ENV=production
ENV PORT=8080

USER 65532:65532

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "const p=process.env.PORT||8080;fetch('http://127.0.0.1:'+p+'/api/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist-server/index.js"]
