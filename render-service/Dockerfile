# Isolated render service: Node 22 + system Chromium + FFmpeg.
#
# Debian (bookworm-slim), NOT Alpine: @hyperframes/producer drives Chromium via
# puppeteer, and Chromium + its shared libraries are far simpler to provision on
# glibc/Debian than on musl/Alpine. We install the distro Chromium and point
# puppeteer at it (PUPPETEER_EXECUTABLE_PATH) so no second browser is downloaded.
FROM node:22-bookworm-slim AS base

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

# chromium + ffmpeg + the fonts/libs a headless Chrome needs to render text and
# composite frames. iptables lets the entrypoint lock down egress (block the
# untrusted Chromium from reaching the app); ca-certificates covers TLS for any
# asset the composition might still reference before lockdown.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     chromium \
     ffmpeg \
     iptables \
     ca-certificates \
     fonts-liberation \
     fonts-noto-color-emoji \
     fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- Dependencies (cached layer) ----
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- Runner ----
FROM base AS runner

# Non-root: Chromium must run with --no-sandbox in a container, so drop privileges.
RUN groupadd --system --gid 1001 render \
  && useradd --system --uid 1001 --gid render --home-dir /app render \
  && mkdir -p /tmp/openmaic-renders \
  && chown -R render:render /app /tmp/openmaic-renders

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=render:render package.json tsconfig.json ./
COPY --chown=render:render src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV PORT=9000 \
    PRODUCER_TMP_PROJECT_DIR=/tmp/openmaic-renders

# NOTE: we intentionally do NOT set `USER render` here. The container starts as
# root so the entrypoint can install the iptables egress lockdown (needs
# CAP_NET_ADMIN), then drops to the unprivileged `render` user via setpriv for
# the Node/Chromium process. See docker-entrypoint.sh.
EXPOSE 9000

# The entrypoint applies the egress lockdown, drops privileges, then runs tsx on
# the TypeScript entry. NOTE: the entry is `main.ts`, not `server.ts`, because
# @hyperframes/producer auto-starts its own bundled server when the process
# entry path ends with `/src/server.ts` (or `/public-server.js`).
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
