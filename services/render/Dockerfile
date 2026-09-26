# Document renderer (Docker deployments). One container serves all tenants, like radeef-face.
# Build from services/render:   docker build -t radeef-render services/render
# Run (bridge address only; never publish on 0.0.0.0), see docs/RUNBOOK.md §6.
# tmpfs: 4 concurrent renders x (8 MB input + 25 MB max PDF) fit in 160 MB.
#   docker run -d --name radeef-render --restart unless-stopped --read-only --cap-drop ALL \
#     --security-opt no-new-privileges --memory 512m --pids-limit 128 --tmpfs /tmp:size=160m,mode=1777 \
#     --env-file /etc/radeef/services/render.env -p 172.17.0.1:8091:8091 radeef-render
# (/etc/radeef/services/, not /etc/radeef/: every /etc/radeef/*.env is treated as a tenant.)

# Node 24 LTS, pinned by digest (update deliberately, then rerun the golden tests).
ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

# ---- pinned Typst binary + font bundle, verified against typst.lock / fonts.lock ----
FROM ${NODE_IMAGE} AS assets
ARG TARGETARCH
RUN apk add --no-cache curl xz
WORKDIR /build
COPY typst.lock fonts.lock ./
COPY scripts/fetch-assets.sh scripts/
RUN sh scripts/fetch-assets.sh /opt/assets "${TARGETARCH:-$(uname -m)}"

# ---- runtime: no shell tools beyond busybox, no package manager use, non-root ----
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    RENDER_HOST=0.0.0.0 \
    RENDER_PORT=8091 \
    RENDER_TMP_DIR=/tmp \
    TYPST_BIN=/srv/render/bin/typst \
    FONTS_DIR=/srv/render/fonts \
    FONTS_LOCK=/srv/render/fonts.lock
WORKDIR /srv/render
COPY package.json fonts.lock typst.lock ./
COPY src ./src
COPY --from=assets /opt/assets/bin ./bin
COPY --from=assets /opt/assets/fonts ./fonts
# Read-only for the service user; npm is not needed at runtime.
RUN adduser -S -D -H -u 10002 render && chmod -R a+rX,go-w /srv/render && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
USER render
EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8091/health || exit 1
CMD ["node", "src/main.mjs"]
