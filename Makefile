# Marumado: docker compose shortcuts. `make` lists them.
COMPOSE ?= docker compose
SERVICE := marumado

.DEFAULT_GOAL := help
.PHONY: help env mounts up down restart build rebuild logs ps shell scan migrate secret token access-token clean dev

help: ## List the shortcuts
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "  \033[1m%-9s\033[0m %s\n", $$1, $$2}'

env: ## Create .env from .env.example (with a fresh secret key) if missing
	@test -f .env || { sed "s/^MARUMADO_SECRET_KEY=.*/MARUMADO_SECRET_KEY=$$(openssl rand -hex 32 2>/dev/null || python3 -c "import secrets;print(secrets.token_hex(32))")/" .env.example > .env && echo "created .env"; }

mounts: env ## Regenerate compose.override.yaml (folder mounts) from .env
	@./scripts/compose-mounts.sh

up: mounts ## Build if needed and start Marumado in the background
	$(COMPOSE) up -d --build
	@. ./.env; echo "Marumado → http://$${MARUMADO_BIND:-127.0.0.1}:$${MARUMADO_PORT:-7878}"

down: ## Stop and remove the container (data volume is kept)
	$(COMPOSE) down

restart: mounts ## Restart the container (picks up .env and folder changes)
	$(COMPOSE) up -d --force-recreate

build: env ## Build the image
	$(COMPOSE) build

rebuild: mounts ## Rebuild from scratch and restart
	$(COMPOSE) build --no-cache
	$(COMPOSE) up -d

logs: ## Follow the logs
	$(COMPOSE) logs -f --tail=200 $(SERVICE)

ps: ## Show container status
	$(COMPOSE) ps

shell: ## Open a shell in the running container
	$(COMPOSE) exec $(SERVICE) sh

scan: ## Rescan the project folders now
	$(COMPOSE) exec $(SERVICE) python manage.py scan

migrate: ## Apply database migrations
	$(COMPOSE) exec $(SERVICE) python manage.py migrate

secret: ## Print a random secret key
	@openssl rand -hex 32 2>/dev/null || python3 -c "import secrets;print(secrets.token_hex(32))"

access-token: ## Print the access token the browser asks for
	$(COMPOSE) exec $(SERVICE) python manage.py token

token: ## Print a random access token for MARUMADO_TOKEN
	@openssl rand -hex 16 2>/dev/null || python3 -c "import secrets;print(secrets.token_hex(16))"

clean: ## Stop and DELETE the data volume (projects you added by hand, uptime history)
	$(COMPOSE) down -v

dev: ## Run without Docker: backend on :7878 + Vite dev server on :5173
	@cd backend && uv run python manage.py serve & cd frontend && npx vite
