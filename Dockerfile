FROM node:24.18.0-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24.18.0-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

ENV NODE_ENV=production \
    PORT=5000 \
    METRICS_DB_PATH=/app/data/metrics.sqlite

WORKDIR /app

RUN rm -rf /usr/local/lib/node_modules/npm \
        /usr/local/lib/node_modules/corepack \
        /opt/yarn-v* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx \
        /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
        /usr/local/bin/pnpm /usr/local/bin/pnpx

COPY --from=dependencies --chown=32767:32767 /app/node_modules ./node_modules
COPY --chown=32767:32767 index.js ./
COPY --chown=32767:32767 lib/docker-metrics.js lib/metrics-collector.js lib/metrics-store.js ./lib/
COPY --chown=32767:32767 public ./public

RUN mkdir -p /app/data && chown 32767:32767 /app/data

EXPOSE 5000

USER 32767:32767
CMD ["node", "--experimental-sqlite", "index.js"]
