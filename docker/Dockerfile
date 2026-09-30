# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# Keep the build and runtime on the same active LTS Node.js major (24 until
# Node 26 enters LTS). Both multi-platform base indexes are digest-pinned so
# release provenance identifies exact inputs; move both majors together.
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

FROM node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe

# The pinned Node image currently ships libssl3t64 3.5.7-1~deb13u2. Upgrade
# only OpenSSL packages until the upstream digest includes 3.5.7-1~deb13u3.
# Remove this workaround when the pinned runtime base carries that fix.
RUN apt-get update \
  && apt-get install --no-install-recommends --only-upgrade --yes libssl3t64 openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/ferrum-edge/ferrum-foundry" \
  org.opencontainers.image.revision="$SOURCE_REVISION"

COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/dist-server ./dist-server
COPY --from=builder --chown=node:node /app/shared/admin-jwt.js ./shared/admin-jwt.js
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./

ENV NODE_ENV=production
ENV PORT=8080

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "const p=process.env.PORT||8080;fetch('http://127.0.0.1:'+p+'/api/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "dist-server/index.js"]
