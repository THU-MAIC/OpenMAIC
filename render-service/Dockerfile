# Isolated render service: Node 22 + Chromium headless shell + FFmpeg.
#
# Debian (bookworm-slim), NOT Alpine: @hyperframes/producer drives Chromium via
# puppeteer, and Chromium + its shared libraries are far simpler to provision on
# glibc/Debian than on musl/Alpine. Producer's beginFrame capture requires the
# old headless shell binary; regular Chromium exposes the resolver path but then
# rejects HeadlessExperimental.beginFrame and silently falls back to screenshots.
FROM node:22.22.2-bookworm-slim@sha256:f3a68cf41a855d227d1b0ab832bed9749469ef38cf4f58182fb8c893bc462383 AS base

ARG CHROMIUM_VERSION=151.0.7922.71-1~deb12u1
ARG FFMPEG_VERSION=7:5.1.9-0+deb12u1
ARG IPTABLES_VERSION=1.8.9-2
ARG CA_CERTIFICATES_VERSION=20230311+deb12u1
ARG FONTS_LIBERATION_VERSION=1:1.07.4-11
ARG FONTS_NOTO_CORE_VERSION=20201225-1
ARG FONTS_NOTO_COLOR_EMOJI_VERSION=2.042-0+deb12u1
ARG FONTS_NOTO_CJK_VERSION=1:20220127+repack1-1
ARG DEBIAN_SNAPSHOT=20260731T162426Z

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-headless-shell \
    NODE_ENV=production

# chromium-headless-shell + ffmpeg + the fonts/libs a headless Chrome needs to
# render text and composite frames. iptables lets the entrypoint lock down egress
# (block the untrusted Chromium from reaching the app); ca-certificates covers
# TLS for any asset the composition might still reference before lockdown. All
# apt indexes come from one dated, signed snapshot so exact versions remain
# installable after they rotate out of the live Debian mirrors. HTTP bootstraps
# the slim image (which has no CA bundle yet); apt still verifies Release files.
RUN printf '%s\n' \
     "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm main" \
     "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm-updates main" \
     "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} bookworm-security main" \
     > /etc/apt/sources.list \
  && rm -f /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
     "chromium-common=${CHROMIUM_VERSION}" \
     "chromium-headless-shell=${CHROMIUM_VERSION}" \
     "ffmpeg=${FFMPEG_VERSION}" \
     "iptables=${IPTABLES_VERSION}" \
     "ca-certificates=${CA_CERTIFICATES_VERSION}" \
     "fonts-liberation=${FONTS_LIBERATION_VERSION}" \
     "fonts-noto-core=${FONTS_NOTO_CORE_VERSION}" \
     "fonts-noto-color-emoji=${FONTS_NOTO_COLOR_EMOJI_VERSION}" \
     "fonts-noto-cjk=${FONTS_NOTO_CJK_VERSION}" \
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
  && mkdir -p /tmp/openmaic-renders /app/.cache \
  && chown -R render:render /app /tmp/openmaic-renders

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=render:render package.json tsconfig.json ./
COPY --chown=render:render src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Strip CR before chmod. .gitattributes keeps this file LF on fresh checkouts,
# but clones made before that landed still hold a CRLF copy, and the resulting
# `#!/bin/sh\r` shebang fails at container start with a message that blames the
# script instead of the interpreter. Normalizing here makes the build
# independent of how the tree was checked out.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

ENV PORT=9000 \
    PRODUCER_TMP_PROJECT_DIR=/tmp/openmaic-renders \
    HOME=/app \
    XDG_CACHE_HOME=/app/.cache \
    PRODUCER_HEADLESS_SHELL_PATH=/usr/bin/chromium-headless-shell \
    RENDER_RESOURCE_PROFILE=standard

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
