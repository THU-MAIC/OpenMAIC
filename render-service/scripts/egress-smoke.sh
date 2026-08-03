#!/bin/sh
# Container egress smoke: verify the render service's security boundary holds —
# a NEW outbound connection from the render container is blocked, while loopback
# (the producer's file server) and inbound-response traffic still work.
#
# Run against a built image (default: openmaic-render-service:pr937):
#   render-service/scripts/egress-smoke.sh [image]
#
# Requires Docker with CAP_NET_ADMIN available (the compose default). Exits 0
# only if: the container boots with lockdown active, /health answers over
# loopback, and a new outbound connection is refused/timed out.
set -eu

IMAGE="${1:-openmaic-render-service:pr937}"
NAME="rs-egress-smoke-$$"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "[smoke] starting $IMAGE with CAP_NET_ADMIN..."
docker run --rm -d --name "$NAME" --cap-add NET_ADMIN "$IMAGE" >/dev/null
sleep 6

echo "[smoke] checking lockdown is reported active..."
docker logs "$NAME" 2>&1 | grep -q "egress lockdown active" || {
  echo "[smoke] FAIL: lockdown not active in logs"; docker logs "$NAME" 2>&1 | tail; exit 1;
}

echo "[smoke] loopback /health must answer..."
HEALTH=$(docker exec "$NAME" node -e 'fetch("http://127.0.0.1:9000/health").then(r=>r.json()).then(j=>{console.log(j.ok===true?"OK":"BAD");process.exit(0)}).catch(()=>{console.log("ERR");process.exit(0)})')
[ "$HEALTH" = "OK" ] || { echo "[smoke] FAIL: loopback health = $HEALTH"; exit 1; }

echo "[smoke] a NEW outbound connection must be blocked..."
OUT=$(docker exec "$NAME" node -e 'const s=require("net").connect({host:"deb.debian.org",port:80});s.setTimeout(4000);s.on("connect",()=>{console.log("REACHABLE");process.exit(0)});s.on("timeout",()=>{console.log("BLOCKED");process.exit(0)});s.on("error",e=>{console.log("BLOCKED_"+e.code);process.exit(0)})')
case "$OUT" in
  BLOCKED*) echo "[smoke] outbound blocked ($OUT)";;
  *) echo "[smoke] FAIL: outbound was $OUT (expected blocked)"; exit 1;;
esac

echo "[smoke] PASS: lockdown active, loopback works, egress blocked."
