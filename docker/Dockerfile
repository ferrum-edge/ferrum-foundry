# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# Keep the build and runtime on the same active LTS Node.js major (24 until
# Node 26 enters LTS). Both multi-platform base indexes are digest-pinned so
# release provenance identifies exact inputs; move both majors together.
FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS builder
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

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:774b7d020b24214835769e24c3544835526cd0288f0b094eae48e8b2c2429a79
WORKDIR /app

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/ferrum-edge/ferrum-foundry" \
  org.opencontainers.image.revision="$SOURCE_REVISION"

COPY --from=builder --chown=nonroot:nonroot /app/dist ./dist
COPY --from=builder --chown=nonroot:nonroot /app/dist-server ./dist-server
COPY --from=builder --chown=nonroot:nonroot /app/shared/admin-jwt.js ./shared/admin-jwt.js
COPY --from=builder --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=builder --chown=nonroot:nonroot /app/package.json ./

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "const p=process.env.PORT||8080;fetch('http://127.0.0.1:'+p+'/api/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["dist-server/index.js"]
