# Dogfood workflow: `make install` builds the full app and installs it as the stable pamA.
# Day-to-day development uses scripts/pama-dev (separate data dir and port). See docs/dogfood.md.
SHELL := /bin/bash
APP_NAME := pamA
APP_DEST := /Applications/$(APP_NAME).app
BIN_DIR := $(HOME)/.local/bin
APP_RES := $(APP_DEST)/Contents

.PHONY: install test dev-link
install:
	pnpm install --frozen-lockfile
	pnpm --filter @pama/web build
	scripts/build-sidecar.sh
	cd crates/pama-desktop/src-tauri && cargo tauri build --config tauri.release.conf.json --bundles app
	cargo build --release -p pama-cli
	@echo "→ installing stable build"
	-$(BIN_DIR)/pama server stop
	-osascript -e 'tell application "$(APP_NAME)" to quit' 2>/dev/null
	rm -rf "$(APP_DEST)"
	cp -R target/release/bundle/macos/$(APP_NAME).app "$(APP_DEST)"
	mkdir -p $(BIN_DIR)
	cp target/release/pama $(BIN_DIR)/pama
	@# The CLI starts `pama-server` next to itself; point it at the server bundled in the app.
	printf '%s\n' '#!/bin/sh' \
	  'R="$(APP_RES)"' \
	  'export PAMA_RULES_DIR="$$R/Resources/rules" PAMA_PROMPTS_DIR="$$R/Resources/prompts"' \
	  'export PAMA_MIGRATIONS_DIR="$$R/Resources/migrations" PAMA_WEB_DIR="$$R/Resources/web"' \
	  'exec "$$R/MacOS/pama-server" "$$@"' > $(BIN_DIR)/pama-server
	chmod +x $(BIN_DIR)/pama-server
	@echo "✓ stable installed: $(APP_DEST) and $(BIN_DIR)/pama"

# One-time: put the dev launcher on PATH.
dev-link:
	mkdir -p $(BIN_DIR)
	ln -sf "$(CURDIR)/scripts/pama-dev" $(BIN_DIR)/pama-dev

# Gate before upgrading stable.
test:
	cargo test --workspace
	pnpm test
	pnpm evals
