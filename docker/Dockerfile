# Stage 1: Build
FROM node:26-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY . .
RUN npm run build

# Prune devDependencies for production
RUN npm prune --production

# Stage 2: Production (distroless)
FROM gcr.io/distroless/nodejs22-debian13:nonroot
WORKDIR /app

# Copy built SPA
COPY --from=builder /app/dist ./dist

# Copy server build
COPY --from=builder /app/dist-server ./dist-server

# Copy production node_modules
COPY --from=builder /app/node_modules ./node_modules

# Copy package.json for module resolution
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "const p=process.env.PORT||8080;fetch('http://127.0.0.1:'+p+'/api/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["dist-server/index.js"]
