# syntax=docker/dockerfile:1.7
# =============================================================================
# Radeef HRMS - production image (one image, one container per tenant).
#
#   docker build -t radeef:$(git rev-parse --short HEAD) .
#
# Runtime configuration comes ONLY from the environment (env_file per tenant, see
# .env.example and docker-compose.yml). No secret is baked into the image.
# =============================================================================

ARG NODE_VERSION=22

# ---------- base: shared OS packages (Prisma needs OpenSSL on Alpine) ----------
FROM node:${NODE_VERSION}-alpine AS base
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1

# ---------- deps: install exactly what package-lock.json pins ----------
FROM base AS deps
# The schema must exist before `npm ci` because the postinstall hook runs `prisma generate`.
COPY package.json package-lock.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---------- builder: generate the Prisma client and build Next (output: standalone) ----------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time placeholders only: nothing connects to a database during the build and these
# values never reach the runner stage.
ENV NODE_ENV=production \
    DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public" \
    SESSION_SECRET="build-time-placeholder-not-used-at-runtime-0000000000"
RUN npx prisma generate && npm run build

# ---------- runner: minimal non-root runtime ----------
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    UPLOAD_DIR=/app/uploads

RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

# Next standalone server (server.js + traced node_modules), static assets and public files.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Prisma: schema + migrations + seed, the generated client/engines, and the CLI for
# `prisma migrate deploy` (used by the one-shot `migrate` compose profile).
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
# bcryptjs is needed by prisma/seed.mjs and scripts/create-admin.mjs.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/bcryptjs ./node_modules/bcryptjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
# `npx prisma` must resolve the bundled CLI instead of downloading one.
RUN mkdir -p node_modules/.bin \
 && ln -sf ../prisma/build/index.js node_modules/.bin/prisma \
 && mkdir -p /app/uploads \
 && chown -R nextjs:nodejs /app/uploads node_modules/.bin

USER nextjs
VOLUME ["/app/uploads"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["node", "server.js"]
