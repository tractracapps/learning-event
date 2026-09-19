# syntax=docker/dockerfile:1.7

# =====================================================
# Stage 1: install production dependencies only
# -----------------------------------------------------
# This layer is keyed on package*.json alone, so code
# changes never trigger a reinstall. All deps are pure
# JS (no native build toolchain needed), and the npm
# cache mount makes repeat builds near-instant.
# =====================================================
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund --prefer-offline


# =====================================================
# Stage 2: minimal runtime image
# =====================================================
FROM node:20-alpine AS runner

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Run as the unprivileged user that ships with the image
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node models ./models
COPY --chown=node:node public ./public

USER node

EXPOSE 3000

# wget ships with busybox on alpine, so no extra packages needed.
# start-period gives Mongo time to connect before failures count.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "server.js"]
