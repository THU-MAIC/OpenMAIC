DEPLOY_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
COMPOSE    := docker compose -f $(DEPLOY_DIR)docker-compose.yml --env-file $(DEPLOY_DIR).env

.PHONY: setup start stop restart logs ps tunnel build pull

## First-time full setup (build image, configure tunnel, start stack)
setup:
	@bash $(DEPLOY_DIR)setup.sh all

## Start the stack
start:
	$(COMPOSE) up -d
	@bash $(DEPLOY_DIR)setup.sh tunnel

## Stop the stack and tunnel
stop:
	$(COMPOSE) down
	@pkill -f "cloudflared tunnel run" 2>/dev/null || true
	@echo "Stack and tunnel stopped."

## Restart all services
restart:
	$(COMPOSE) restart

## Follow logs (all services)
logs:
	$(COMPOSE) logs -f --tail=100

## Show running containers
ps:
	$(COMPOSE) ps

## Rebuild OpenMAIC image
build:
	$(COMPOSE) build --no-cache openmaic

## Pull latest base images
pull:
	$(COMPOSE) pull

## Re-create Cloudflare tunnel only
tunnel:
	@bash $(DEPLOY_DIR)setup.sh tunnel

## Open Keycloak admin console
keycloak-admin:
	@open "https://my-learning.amtocbot.com/auth/admin"

## Show current tunnel status
tunnel-status:
	@cloudflared tunnel list
	@cat $(DEPLOY_DIR)cloudflared/tunnel.pid 2>/dev/null | xargs -I{} sh -c 'kill -0 {} 2>/dev/null && echo "Tunnel running (PID {})" || echo "Tunnel not running"'
