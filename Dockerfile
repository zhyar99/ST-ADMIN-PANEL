# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# streaming-backbone — production image
#
# One Node process serves the Admin SPA, the API and uploaded media, so this is
# a single image with a single port. It is built in four stages so the runtime
# layer carries no source, no toolchain and no dev dependencies:
#
#   base       pinned Node + pnpm
#   deps       full install (dev included) — needed to compile
#   build      Admin SPA + server bundle
#   prod-deps  the same lockfile, resolved with --prod
#   runtime    dist + drizzle SQL + prod node_modules, run as a non-root user
# ---------------------------------------------------------------------------

# Bookworm rather than Alpine: sharp and argon2 both ship prebuilt glibc
# binaries, and musl would push them onto a source build inside the image.
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# corepack reads `packageManager` from package.json, so the pnpm that installs
# is the pnpm that wrote pnpm-lock.yaml.
RUN corepack enable
WORKDIR /app


FROM base AS deps
# Manifests and the lockfile only: this layer is then reused by every build that
# does not change a dependency, which is most of them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/admin/package.json ./apps/admin/
COPY apps/server/package.json ./apps/server/
COPY packages/shared/package.json ./packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile


FROM deps AS build
COPY . .
# Builds the SPA, bundles the server, and copies apps/admin/dist into
# apps/server/public/admin — the directory Express serves /admin from.
RUN pnpm build


FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/admin/package.json ./apps/admin/
COPY apps/server/package.json ./apps/server/
COPY packages/shared/package.json ./packages/shared/
# Only the server and what it depends on: the Admin SPA is static output by now
# and none of its packages are needed at runtime.
#
# The mkdir is for Docker's benefit, not pnpm's — COPY fails on a missing
# source, and a package whose prod dependencies are all hoisted can legitimately
# end up with no node_modules directory of its own.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @streaming/server... \
    && mkdir -p /app/apps/server/node_modules /app/packages/shared/node_modules


FROM base AS runtime
ENV NODE_ENV=production
# Koyeb injects PORT; this is the default the app binds when it does not.
ENV PORT=8000
# The platform's filesystem is ephemeral, so this is where a persistent volume
# is expected to be mounted. See DEPLOYMENT.md.
ENV STORAGE_DIR=/data/storage
# Same-origin: the SPA and the media it renders are served by this process, and
# the public hostname is assigned by the platform rather than known at build time.
ENV STORAGE_URL_PREFIX=/storage
# One proxy hop — Koyeb's edge — so req.ip is the real client and the rate
# limiters key on it.
ENV TRUST_PROXY=1

# pnpm resolves through symlinks into the root store, so all three trees have to
# travel together.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules

COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/public ./apps/server/public

# Read at runtime: the migrator reads the SQL files, and paths.ts walks up from
# apps/server to find the repo root.
COPY apps/server/drizzle ./apps/server/drizzle
COPY apps/server/package.json ./apps/server/
COPY package.json ./
COPY docker-entrypoint.sh /usr/local/bin/

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data/storage \
    && chown -R node:node /data

# The `node` user ships with the image; nothing here needs root.
USER node

EXPOSE 8000

# Liveness only — /health touches no dependency, so a database blip cannot get
# a healthy container killed. /ready is the one to point a load balancer at.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "apps/server/dist/server.js"]
