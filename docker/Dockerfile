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

# Distroless: no shell, no package manager, and Node as the only executable
# entrypoint at /nodejs/bin/node. The image's own user is nonroot (65532), set
# numerically below so Kubernetes `runAsNonRoot` can verify it.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e

WORKDIR /app

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/ferrum-edge/ferrum-foundry" \
  org.opencontainers.image.revision="$SOURCE_REVISION"

COPY --from=builder --chown=65532:65532 /app/dist ./dist
COPY --from=builder --chown=65532:65532 /app/dist-server ./dist-server
COPY --from=builder --chown=65532:65532 /app/shared ./shared/
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
