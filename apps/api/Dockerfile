# syntax=docker/dockerfile:1.7
# ECEWS TalentScreen — API, worker and migration image (one image, three commands)

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --omit=optional

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    API_PORT=3000 \
    STORAGE_LOCAL_DIR=/data/uploads
RUN apk add --no-cache tini && mkdir -p /data/uploads && chown -R node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node seed ./seed
COPY --chown=node:node assets ./assets
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# api (default) | worker: node dist/worker.js | migrations: node dist/migrate.js
CMD ["node", "dist/main.js"]
