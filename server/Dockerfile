# syntax=docker/dockerfile:1
# Meldiq API (formerly Orbit and Griip Message) — multi-stage build, runs as non-root.
FROM node:22.22.3-alpine3.24 AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
# The test-only MongoDB binary (mongodb-memory-server, a dev dependency pruned below) is never needed in the image.
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.22.3-alpine3.24
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
WORKDIR /app
# ffmpeg and a font: AI Workforce's media engine (docs/AI_WORKFORCE.md); the server detects what it can do at start.
RUN apk add --no-cache tini wget ffmpeg font-dejavu && mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
# Meldiq's own profile decorations and the template (scripts/render-decorations.mjs, docs/PROFILE_DECORATIONS.md).
COPY --chown=node:node assets ./assets
COPY --chown=node:node package.json ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
