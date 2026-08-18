### ---- frontend-builder ----
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

### ---- backend-builder ----
FROM node:20-alpine AS backend-builder
RUN apk add --no-cache python3 make g++ sqlite
WORKDIR /app/backend
COPY backend/package*.json ./
# patches/ has to land BEFORE npm ci. postinstall runs patch-package, and with no
# patches directory it exits 0 having done nothing — silently shipping a Baileys
# whose per-socket AsyncLocalStorage leak is back.
COPY backend/patches ./patches
RUN npm ci
COPY backend/ ./
RUN npm run build && npm prune --production
# Fail the build rather than ship an unpatched Baileys. npm prune runs after the
# patch was applied and does not re-install, so this asserts what actually gets
# copied into the runtime stage.
RUN grep -q signalTxStore node_modules/@whiskeysockets/baileys/lib/Utils/auth-utils.js \
    || { echo 'FATAL: Baileys ALS patch is missing from the image — see backend/patches/' >&2; exit 1; }

### ---- runtime ----
FROM node:20-alpine AS runtime
RUN apk add --no-cache sqlite tzdata

WORKDIR /app
RUN mkdir -p /app/backend/data && chown -R node:node /app

COPY --chown=node:node --from=backend-builder /app/backend/dist /app/backend/dist
COPY --chown=node:node --from=backend-builder /app/backend/drizzle /app/backend/drizzle
COPY --chown=node:node --from=backend-builder /app/backend/node_modules /app/backend/node_modules
COPY --chown=node:node --from=backend-builder /app/backend/package.json /app/backend/package.json
COPY --chown=node:node --from=frontend-builder /app/frontend/dist /app/frontend/dist

COPY deploy/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

USER node
WORKDIR /app/backend
ENV NODE_ENV=production

EXPOSE 3000
ENTRYPOINT ["/app/entrypoint.sh"]
