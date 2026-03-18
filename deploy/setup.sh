#!/usr/bin/env bash
# =============================================================================
# OpenMAIC Self-Hosted — Setup Script
#
# Usage:
#   ./setup.sh          — full first-time setup
#   ./setup.sh tunnel   — re-create / update Cloudflare tunnel only
#   ./setup.sh secrets  — regenerate .env secrets only (destructive)
# =============================================================================

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAIN="my-learning.amtocbot.com"
TUNNEL_NAME="openmaic-tunnel"
CF_CONFIG="$HOME/.cloudflared/config.yml"
ENV_FILE="$DEPLOY_DIR/.env"
REALM_TEMPLATE="$DEPLOY_DIR/keycloak/realm-export.json.template"
REALM_OUTPUT="$DEPLOY_DIR/keycloak/realm-export.json"

# ── Colours ───────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[setup]${NC} $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC}  $*"; }
error()   { echo -e "${RED}[error]${NC} $*"; exit 1; }

# ── Helpers ───────────────────────────────────────────────────────────────
require() { command -v "$1" &>/dev/null || error "Required tool not found: $1"; }
gen_secret() { openssl rand -base64 32 | tr -d '=/+' | head -c 32; }
gen_cookie_secret() { openssl rand -base64 32; }  # oauth2-proxy needs exactly 32 bytes base64

# ── Pre-flight checks ─────────────────────────────────────────────────────
require docker
require cloudflared
require openssl
require envsubst

info "All pre-flight checks passed."

# ═══════════════════════════════════════════════════════════════════════════
# 1. Generate / load secrets
# ═══════════════════════════════════════════════════════════════════════════
generate_secrets() {
  if [[ -f "$ENV_FILE" && "${1:-}" != "force" ]]; then
    warn ".env already exists — skipping secret generation (run with 'secrets' to regenerate)."
    return
  fi

  info "Generating secrets → $ENV_FILE"

  POSTGRES_PASSWORD=$(gen_secret)
  KEYCLOAK_MASTER_PASSWORD=$(gen_secret)
  OAUTH2_CLIENT_SECRET=$(gen_secret)
  OAUTH2_COOKIE_SECRET=$(gen_cookie_secret | head -c 32 | base64)
  ADMIN_PASSWORD="Openmaic@202602"

  # Copy template and fill generated values
  cp "$DEPLOY_DIR/.env.template" "$ENV_FILE"
  sed -i '' \
    -e "s|POSTGRES_PASSWORD=GENERATED_BY_SETUP|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" \
    -e "s|KEYCLOAK_MASTER_PASSWORD=GENERATED_BY_SETUP|KEYCLOAK_MASTER_PASSWORD=${KEYCLOAK_MASTER_PASSWORD}|" \
    -e "s|OAUTH2_CLIENT_SECRET=GENERATED_BY_SETUP|OAUTH2_CLIENT_SECRET=${OAUTH2_CLIENT_SECRET}|" \
    -e "s|OAUTH2_COOKIE_SECRET=GENERATED_BY_SETUP|OAUTH2_COOKIE_SECRET=${OAUTH2_COOKIE_SECRET}|" \
    -e "s|ADMIN_PASSWORD=GENERATED_BY_SETUP|ADMIN_PASSWORD=${ADMIN_PASSWORD}|" \
    "$ENV_FILE"

  info "Secrets written to .env"
  warn "Fill in SMTP_* fields in .env before starting the stack!"
}

# ═══════════════════════════════════════════════════════════════════════════
# 2. Build Keycloak realm JSON from template
# ═══════════════════════════════════════════════════════════════════════════
build_realm_json() {
  info "Building Keycloak realm JSON from template…"

  # Load env vars
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a

  # envsubst replaces ${VAR} placeholders
  envsubst < "$REALM_TEMPLATE" > "$REALM_OUTPUT"
  info "Realm JSON written to $REALM_OUTPUT"
}

# ═══════════════════════════════════════════════════════════════════════════
# 3. Cloudflare Tunnel
# ═══════════════════════════════════════════════════════════════════════════
setup_tunnel() {
  info "Setting up Cloudflare Tunnel: $TUNNEL_NAME → $DOMAIN"

  # Authenticate (opens browser on first run)
  if [[ ! -f "$HOME/.cloudflared/cert.pem" ]]; then
    info "Opening browser for Cloudflare authentication…"
    cloudflared tunnel login
  else
    info "Cloudflare credentials found — skipping login."
  fi

  # Create tunnel if it doesn't exist
  if cloudflared tunnel list 2>/dev/null | grep -q "$TUNNEL_NAME"; then
    warn "Tunnel '$TUNNEL_NAME' already exists — reusing."
    TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | grep "$TUNNEL_NAME" | awk '{print $1}')
  else
    info "Creating tunnel '$TUNNEL_NAME'…"
    cloudflared tunnel create "$TUNNEL_NAME"
    TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | grep "$TUNNEL_NAME" | awk '{print $1}')
  fi

  info "Tunnel ID: $TUNNEL_ID"

  # Route DNS
  info "Routing DNS: $DOMAIN → $TUNNEL_NAME"
  cloudflared tunnel route dns --overwrite-dns "$TUNNEL_NAME" "$DOMAIN" || \
    warn "DNS route may already exist — continuing."

  # Write cloudflared config
  info "Writing cloudflared config to $CF_CONFIG"
  mkdir -p "$(dirname "$CF_CONFIG")"
  cat > "$CF_CONFIG" <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${HOME}/.cloudflared/${TUNNEL_ID}.json

ingress:
  - hostname: ${DOMAIN}
    service: http://localhost:8088
    originRequest:
      connectTimeout: 30s
  - service: http_status:404
EOF

  # Also write a local copy for reference
  sed "s/TUNNEL_ID_PLACEHOLDER/${TUNNEL_ID}/g" \
    "$DEPLOY_DIR/cloudflared/config.yml.template" \
    > "$DEPLOY_DIR/cloudflared/config.yml"

  info "Cloudflare Tunnel configured."
}

# ═══════════════════════════════════════════════════════════════════════════
# 4. Build Docker image
# ═══════════════════════════════════════════════════════════════════════════
build_image() {
  info "Building OpenMAIC Docker image (this takes a few minutes)…"
  docker compose -f "$DEPLOY_DIR/docker-compose.yml" build --no-cache openmaic
  info "Image built."
}

# ═══════════════════════════════════════════════════════════════════════════
# 5. Start the stack
# ═══════════════════════════════════════════════════════════════════════════
start_stack() {
  info "Starting Docker Compose stack…"
  docker compose -f "$DEPLOY_DIR/docker-compose.yml" --env-file "$ENV_FILE" up -d
  info "Stack started."
}

# ═══════════════════════════════════════════════════════════════════════════
# 6. Start Cloudflare Tunnel daemon
# ═══════════════════════════════════════════════════════════════════════════
start_tunnel() {
  # Kill any existing tunnel process
  pkill -f "cloudflared tunnel run" 2>/dev/null || true

  info "Starting Cloudflare Tunnel daemon (background)…"
  nohup cloudflared tunnel --config "$CF_CONFIG" run "$TUNNEL_NAME" \
    >> "$DEPLOY_DIR/cloudflared/tunnel.log" 2>&1 &

  echo $! > "$DEPLOY_DIR/cloudflared/tunnel.pid"
  info "Tunnel running (PID $(cat "$DEPLOY_DIR/cloudflared/tunnel.pid"))."
  info "Logs: $DEPLOY_DIR/cloudflared/tunnel.log"
}

# ═══════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════
case "${1:-all}" in
  secrets)
    generate_secrets force
    build_realm_json
    ;;
  tunnel)
    setup_tunnel
    start_tunnel
    ;;
  build)
    generate_secrets
    build_realm_json
    build_image
    ;;
  all)
    generate_secrets
    build_realm_json
    setup_tunnel
    build_image
    start_stack
    start_tunnel

    echo ""
    echo "════════════════════════════════════════════════════════════"
    echo "  OpenMAIC is starting up!"
    echo ""
    echo "  URL:          https://${DOMAIN}"
    echo "  Admin login:  admin@amtocbot.com"
    echo ""
    echo "  Keycloak admin console:"
    echo "    https://${DOMAIN}/auth/admin"
    echo "    (login with KEYCLOAK_MASTER_ADMIN from .env)"
    echo ""
    echo "  To invite a new user:"
    echo "    1. Go to https://${DOMAIN}/auth/admin/openmaic/console"
    echo "    2. Users → Add user → fill email → Actions → Send email verification"
    echo ""
    echo "  To stop:      make -C deploy stop"
    echo "  To view logs: make -C deploy logs"
    echo "════════════════════════════════════════════════════════════"
    ;;
  *)
    echo "Usage: $0 [all|secrets|tunnel|build]"
    exit 1
    ;;
esac
