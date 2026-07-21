#!/bin/sh
# Render-service entrypoint.
#
# The service renders UNTRUSTED, uploaded HTML in Chromium. The export ZIP is
# fully self-contained (all assets + vendored GSAP are bundled at build time and
# served to Chromium over loopback), so the render needs ZERO outbound network.
# We enforce that here: block all egress except loopback and replies on already
# established (app-initiated) connections. This is the boundary that stops the
# untrusted page from initiating connections back to the app (e.g. the compose
# `openmaic` service) or anywhere else, even though both share a Docker network.
#
# Requires the container to start as root with CAP_NET_ADMIN (compose:
# `cap_add: [NET_ADMIN]`). We install the rules as root, then drop to the
# unprivileged `render` user for the Node process.
#
# FAIL CLOSED: when the lockdown is requested (RENDER_EGRESS_LOCKDOWN=true, the
# default) but cannot be installed, we EXIT non-zero rather than start an
# unisolated service that /health would still report as healthy — the app would
# otherwise advertise MP4 rendering while Chromium could reach the app. An
# operator who knowingly accepts an unisolated standalone setup must opt out
# explicitly with RENDER_EGRESS_LOCKDOWN=false.
set -eu

lockdown() {
  # ESTABLISHED,RELATED lets the Hono API respond to the app's inbound requests;
  # loopback lets the producer's file server + Chromium talk locally. Everything
  # else outbound (new connections, DNS to resolve `openmaic`, etc.) is dropped.
  # IPv4 rules must all succeed; IPv6 is best-effort (the stack/table may be
  # absent), but when present we still default-drop so v6 can't be an escape.
  iptables -A OUTPUT -o lo -j ACCEPT || return 1
  iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT || return 1
  iptables -P OUTPUT DROP || return 1
  if command -v ip6tables >/dev/null 2>&1; then
    ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
    ip6tables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
    ip6tables -P OUTPUT DROP 2>/dev/null || true
  fi
  return 0
}

if [ "${RENDER_EGRESS_LOCKDOWN:-true}" = "true" ]; then
  if [ "$(id -u)" != "0" ]; then
    echo "[render-service] FATAL: egress lockdown requested but not running as root (need root + CAP_NET_ADMIN). Set RENDER_EGRESS_LOCKDOWN=false to run unisolated." >&2
    exit 1
  fi
  if ! command -v iptables >/dev/null 2>&1; then
    echo "[render-service] FATAL: egress lockdown requested but iptables is not installed. Set RENDER_EGRESS_LOCKDOWN=false to run unisolated." >&2
    exit 1
  fi
  if ! lockdown; then
    echo "[render-service] FATAL: egress lockdown requested but iptables rules failed to apply (missing CAP_NET_ADMIN or backend mismatch). Refusing to start unisolated. Set RENDER_EGRESS_LOCKDOWN=false to override." >&2
    exit 1
  fi
  echo "[render-service] egress lockdown active (outbound blocked except loopback)"
else
  echo "[render-service] WARNING: egress lockdown DISABLED (RENDER_EGRESS_LOCKDOWN=false). Chromium can reach the Docker network — only safe on a network you have isolated yourself." >&2
fi

# Drop privileges to the unprivileged render user for the Node process. When
# already running as that user (no lockdown / non-root start), exec directly.
if [ "$(id -u)" = "0" ]; then
  exec setpriv --reuid=render --regid=render --init-groups node_modules/.bin/tsx src/main.ts
fi
exec node_modules/.bin/tsx src/main.ts
