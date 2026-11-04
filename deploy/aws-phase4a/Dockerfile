FROM node:22.22.3-alpine3.24@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
COPY shared/ /shared/
COPY docs/ /docs/
RUN npm run build

FROM node:22.22.3-alpine3.24@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd AS production-dependencies
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY server/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22.22.3-alpine3.24@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd
ARG SOURCE_REVISION
LABEL org.meldiq.phase="4a-isolated" org.opencontainers.image.revision=$SOURCE_REVISION
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
WORKDIR /app
RUN apk add --no-cache tini wget ffmpeg font-dejavu && mkdir -p /data && chown node:node /data
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node server/assets ./assets
COPY --chown=node:node server/migrations ./migrations
COPY --chown=node:node server/scripts ./scripts
COPY --chown=node:node server/package.json ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
