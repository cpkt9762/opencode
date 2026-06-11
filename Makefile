SIGN_IDENTITY ?= -
DESKTOP_DIR   := packages/desktop
ELECTRON_DIR  := packages/desktop
OPENCODE_DIR  := packages/opencode
PROD_CONF     := src-tauri/tauri.prod.conf.json
BUNDLE_DIR    := $(DESKTOP_DIR)/src-tauri/target/release/bundle/macos
SIDECAR_DIR   := $(DESKTOP_DIR)/src-tauri/sidecars
ELECTRON_RESOURCES := $(ELECTRON_DIR)/resources
ELECTRON_DIST := $(ELECTRON_DIR)/dist
APP_NAME      := OpenCode.app
INSTALL_DIR   := /Applications
BUN           := $(shell which bun 2>/dev/null || echo ~/.bun/bin/bun)
export PATH   := $(dir $(BUN)):$(PATH)

# Channel for Electron build: dev | beta | prod
# Defaults to prod so electron-install overwrites the existing /Applications/OpenCode.app
# (appId = ai.opencode.desktop). Use OPENCODE_CHANNEL=dev|beta to build side-by-side.
OPENCODE_CHANNEL ?= prod
export OPENCODE_CHANNEL

# Version override (optional). If set, uses this exact version instead of auto-detecting.
# This mirrors official CI which passes OPENCODE_VERSION from the version job.
# Example: make electron-install OPENCODE_VERSION=0.2.5
ifdef OPENCODE_VERSION
  export OPENCODE_VERSION
  VERSION_ENV := OPENCODE_VERSION=$(OPENCODE_VERSION)
else
  VERSION_ENV :=
endif

# Debug flag: set CLI_DEBUG=1 to build opencode CLI with:
# - Sourcemaps via linked .map files (auto-resolves from dist/$(OC_DIST)/bin/opencode.js.map)
# - No identifier minification
# - Bun inspector enabled (launch with OPENCODE_INSPECT=1 to attach Chrome DevTools)
#
# Usage:
#   make cli CLI_DEBUG=1                # debug Tauri sidecar
#   make electron-install CLI_DEBUG=1   # debug Electron install
#   make cli-debug                      # convenience alias for cli
#   make electron-install-debug         # convenience alias for electron-install
#
# Note: uses `=` (recursive) not `:=` so target-specific CLI_DEBUG propagates
# through prerequisites (see electron-install-debug alias at the bottom).
CLI_DEBUG ?=
CLI_DEBUG_FLAG = $(if $(CLI_DEBUG),--debug)

# .app name differs by channel (electron-builder.config.ts productName mapping)
ifeq ($(OPENCODE_CHANNEL),dev)
  ELECTRON_APP := OpenCode Dev.app
else ifeq ($(OPENCODE_CHANNEL),beta)
  ELECTRON_APP := OpenCode Beta.app
else
  ELECTRON_APP := OpenCode.app
endif

# Detect macOS arch for sidecar target triple + electron-builder output dir
ARCH := $(shell uname -m)
ifeq ($(ARCH),arm64)
  RUST_TARGET := aarch64-apple-darwin
  OC_DIST     := opencode-darwin-arm64
  BUILD_FLAGS :=
  ELECTRON_MAC_DIR := mac-arm64
else
  RUST_TARGET := x86_64-apple-darwin
  OC_DIST     := opencode-darwin-x64-baseline
  BUILD_FLAGS := --baseline
  ELECTRON_MAC_DIR := mac
endif
export RUST_TARGET

OMO_DIR       := 3rd-github/oh-my-openagent

.PHONY: all build install uninstall dev clean cli cli-debug sdk omo \
        electron-cli electron-build electron-package \
        electron-install electron-uninstall electron-dev electron-clean \
        electron-cli-debug electron-build-debug electron-package-debug electron-install-debug

# Build production binary (default = Tauri; use 'electron-*' targets for Electron)
all: build

# Regenerate JS SDK from OpenAPI spec
sdk:
	$(BUN) run --cwd packages/sdk/js script/build.ts

# Build oh-my-openagent plugin
omo:
	$(BUN) run --cwd $(OMO_DIR) build

# =============================================================================
# Tauri targets (default `make build` / `make install` stay on Tauri)
# =============================================================================

# Build opencode CLI sidecar for Tauri
# Uses OPENCODE_CHANNEL=latest so packages/script stamps the real version
# (not the "0.0.0-<channel>-<timestamp>" preview format reserved for non-latest channels).
# Override with OPENCODE_VERSION=x.y.z to use exact version (mirrors official CI).
# Set CLI_DEBUG=1 for debug build (sourcemaps + inspector — see CLI_DEBUG above).
cli: sdk
	PATH="$(dir $(BUN)):$$PATH" OPENCODE_CHANNEL=latest $(VERSION_ENV) $(BUN) run --cwd $(OPENCODE_DIR) build --single $(CLI_DEBUG_FLAG) $(BUILD_FLAGS)
	@mkdir -p $(SIDECAR_DIR)
	cp $(OPENCODE_DIR)/dist/$(OC_DIST)/bin/opencode $(SIDECAR_DIR)/opencode-cli-$(RUST_TARGET)

# Debug CLI build convenience alias. Equivalent to: make cli CLI_DEBUG=1
# See the CLI_DEBUG variable definition near the top of this file for what
# "debug" means (sourcemaps + no minification + Bun inspector).
#
# Usage:
#   make cli-debug                          # builds debug binary into dist/ + Tauri sidecar
#   make electron-install-debug             # builds + installs debug binary into OpenCode.app
#   make electron-install CLI_DEBUG=1       # same as electron-install-debug
#
# DO NOT USE: `make cli-debug electron-install` — the electron-install chain
# re-runs electron-cli (PHONY) without CLI_DEBUG set in its scope, silently
# overwriting the debug binary with a release build. Use electron-install-debug
# or `make electron-install CLI_DEBUG=1` instead.
#
# Profiling workflow after install:
#   1. Quit OpenCode.app
#   2. Run manually: OPENCODE_INSPECT=1 /Applications/OpenCode.app/Contents/Resources/opencode-cli serve --port 58714
#   3. Open Chrome → chrome://inspect → "Open dedicated DevTools for Node"
#   4. Go to "Profiler" tab → Start → reproduce the CPU spike → Stop
#   5. Source maps auto-resolve from dist/$(OC_DIST)/bin/opencode.js.map
#
# Note: 'sample' (macOS native profiler) will still show '???' because Bun's
# JSC JIT does not emit DWARF symbols — use Chrome DevTools instead.
cli-debug: CLI_DEBUG := 1
cli-debug: cli
	@echo "Debug binary + .map files built. See 'make cli-debug' comment for profiling workflow."

# Build production Tauri binary (rebuilds CLI sidecar first)
# tauri build may fail at updater signing when TAURI_SIGNING_PRIVATE_KEY is unset;
# the .app bundle is still produced, so treat that as success.
build: cli
	PATH="$(dir $(BUN)):$$PATH" $(BUN) run --cwd $(DESKTOP_DIR) tauri build -c $(PROD_CONF) || \
		([ -d "$(BUNDLE_DIR)/$(APP_NAME)" ] && echo "Build ok (updater signing skipped — set TAURI_SIGNING_PRIVATE_KEY for full release)")

# Sign + install Tauri build to /Applications (backs up existing)
install:
	@if [ -d "$(INSTALL_DIR)/$(APP_NAME)" ] && [ ! -d "$(INSTALL_DIR)/$(APP_NAME).bak" ]; then \
		echo "Backing up $(INSTALL_DIR)/$(APP_NAME)"; \
		mv "$(INSTALL_DIR)/$(APP_NAME)" "$(INSTALL_DIR)/$(APP_NAME).bak"; \
	elif [ -d "$(INSTALL_DIR)/$(APP_NAME)" ]; then \
		rm -rf "$(INSTALL_DIR)/$(APP_NAME)"; \
	fi
	cp -r $(BUNDLE_DIR)/$(APP_NAME) $(INSTALL_DIR)/
	codesign --force --deep --sign "$(SIGN_IDENTITY)" $(INSTALL_DIR)/$(APP_NAME)
	@mkdir -p /opt/homebrew/bin $(HOME)/.opencode/bin
	cp $(OPENCODE_DIR)/dist/$(OC_DIST)/bin/opencode /opt/homebrew/bin/opencode.tmp && mv /opt/homebrew/bin/opencode.tmp /opt/homebrew/bin/opencode
	cp $(OPENCODE_DIR)/dist/$(OC_DIST)/bin/opencode $(HOME)/.opencode/bin/opencode.tmp && mv $(HOME)/.opencode/bin/opencode.tmp $(HOME)/.opencode/bin/opencode
	@echo "Installed and signed. Run 'brew pin opencode-desktop' to prevent brew overwrite."

# Restore official Tauri version
uninstall:
	@if [ -d "$(INSTALL_DIR)/$(APP_NAME).bak" ]; then \
		rm -rf "$(INSTALL_DIR)/$(APP_NAME)"; \
		mv "$(INSTALL_DIR)/$(APP_NAME).bak" "$(INSTALL_DIR)/$(APP_NAME)"; \
		echo "Restored official version."; \
	else \
		echo "No backup found."; \
	fi

# Dev mode with prod config (Tauri hot reload)
dev:
	$(BUN) run --cwd $(DESKTOP_DIR) tauri dev -c $(PROD_CONF)

# Clean Tauri build artifacts
clean:
	cargo clean --manifest-path $(DESKTOP_DIR)/src-tauri/Cargo.toml

# =============================================================================
# Electron targets (packages/desktop-electron)
# Entry point: `make electron-install` runs the full chain end-to-end:
#   _opencode-cli-dist -> electron-cli -> electron-build -> electron-package -> electron-install
# Override channel: `make electron-install OPENCODE_CHANNEL=dev|beta|prod`
# =============================================================================

# Build opencode CLI sidecar for Electron and embed it into resources/
# - Uses OPENCODE_CHANNEL=latest so packages/script stamps the real version
#   (not the "0.0.0-<channel>-<timestamp>" preview format reserved for non-latest channels).
# - Override with OPENCODE_VERSION=x.y.z to use exact version (mirrors official CI).
# - Set CLI_DEBUG=1 for debug build (sourcemaps + inspector — see CLI_DEBUG above).
# - Copies it to resources/opencode-cli so electron-builder's extraResources filter
#   ("opencode-cli*") picks it up at packaging time.
# - Ad-hoc codesigns the binary so macOS Gatekeeper doesn't reject the sidecar
#   when the embedded child process is launched at runtime.
electron-cli: sdk
	PATH="$(dir $(BUN)):$$PATH" OPENCODE_CHANNEL=latest $(VERSION_ENV) $(BUN) run --cwd $(OPENCODE_DIR) build --single $(CLI_DEBUG_FLAG) $(BUILD_FLAGS)
	PATH="$(dir $(BUN)):$$PATH" OPENCODE_CHANNEL=latest $(VERSION_ENV) $(BUN) run --cwd $(OPENCODE_DIR) script/build-node.ts
	@mkdir -p $(ELECTRON_RESOURCES)
	cp $(OPENCODE_DIR)/dist/$(OC_DIST)/bin/opencode $(ELECTRON_RESOURCES)/opencode-cli
	codesign --force --sign "$(SIGN_IDENTITY)" $(ELECTRON_RESOURCES)/opencode-cli
	@echo "Electron CLI sidecar copied to $(ELECTRON_RESOURCES)/opencode-cli (channel=latest$(if $(CLI_DEBUG), DEBUG))"

# Compile main/preload/renderer bundles into $(ELECTRON_DIR)/out/
# (bun's pre<script> hook auto-runs `prebuild` = scripts/copy-icons.ts, which
#  reads the exported OPENCODE_CHANNEL to pick the right icon set.)
electron-build: electron-cli
	PATH="$(dir $(BUN)):$$PATH" $(BUN) run --cwd $(ELECTRON_DIR) build

# Package .app + .dmg + .zip into $(ELECTRON_DIR)/dist/<ELECTRON_MAC_DIR>/
electron-package: electron-build
	PATH="$(dir $(BUN)):$$PATH" $(BUN) run --cwd $(ELECTRON_DIR) package:mac

# Sign + install Electron build to /Applications (backs up existing)
# Also refreshes /opt/homebrew/bin/opencode and ~/.opencode/bin/opencode to the
# freshly-built CLI (same policy as the Tauri `install` target).
#
# NOTE: electron-builder already ad-hoc signs the .app inside `dist/mac-arm64/`,
# so we do NOT re-run `codesign --force --deep` here — it fails on Electron's
# nested Electron Framework.framework with "bundle format is ambiguous". We
# only run a non-deep verify pass and trust electron-builder's signature.
#
# For the two system PATH binaries (/opt/homebrew/bin/opencode and
# ~/.opencode/bin/opencode) we do `cp -> codesign -> mv` atomically so macOS
# Gatekeeper accepts them — otherwise the freshly-built binary has no
# signature and Gatekeeper will refuse to launch it.
electron-install: electron-package
	@if [ -d "$(INSTALL_DIR)/$(ELECTRON_APP)" ] && [ ! -d "$(INSTALL_DIR)/$(ELECTRON_APP).bak" ]; then \
		echo "Backing up $(INSTALL_DIR)/$(ELECTRON_APP)"; \
		mv "$(INSTALL_DIR)/$(ELECTRON_APP)" "$(INSTALL_DIR)/$(ELECTRON_APP).bak"; \
	elif [ -d "$(INSTALL_DIR)/$(ELECTRON_APP)" ]; then \
		rm -rf "$(INSTALL_DIR)/$(ELECTRON_APP)"; \
	fi
	cp -r "$(ELECTRON_DIST)/$(ELECTRON_MAC_DIR)/$(ELECTRON_APP)" "$(INSTALL_DIR)/"
	@codesign -dv "$(INSTALL_DIR)/$(ELECTRON_APP)" 2>&1 | grep -E 'Signature|Identifier' || true
	@mkdir -p /opt/homebrew/bin $(HOME)/.opencode/bin
	@echo ">> Installing /opt/homebrew/bin/opencode (cp -> sign -> mv)"
	cp $(OPENCODE_DIR)/dist/$(OC_DIST)/bin/opencode /opt/homebrew/bin/opencode.tmp && \
		codesign --force --sign "$(SIGN_IDENTITY)" /opt/homebrew/bin/opencode.tmp && \
		mv /opt/homebrew/bin/opencode.tmp /opt/homebrew/bin/opencode
	@echo ">> Installing $(HOME)/.opencode/bin/opencode (cp -> sign -> mv)"
	cp $(OPENCODE_DIR)/dist/$(OC_DIST)/bin/opencode $(HOME)/.opencode/bin/opencode.tmp && \
		codesign --force --sign "$(SIGN_IDENTITY)" $(HOME)/.opencode/bin/opencode.tmp && \
		mv $(HOME)/.opencode/bin/opencode.tmp $(HOME)/.opencode/bin/opencode
	@echo "Installed $(ELECTRON_APP) + signed system binaries (channel=$(OPENCODE_CHANNEL))."

# Restore official Electron version
electron-uninstall:
	@if [ -d "$(INSTALL_DIR)/$(ELECTRON_APP).bak" ]; then \
		rm -rf "$(INSTALL_DIR)/$(ELECTRON_APP)"; \
		mv "$(INSTALL_DIR)/$(ELECTRON_APP).bak" "$(INSTALL_DIR)/$(ELECTRON_APP)"; \
		echo "Restored official $(ELECTRON_APP)."; \
	else \
		echo "No backup found for $(ELECTRON_APP)."; \
	fi

# Electron dev mode (electron-vite dev with hot reload)
electron-dev:
	$(BUN) run --cwd $(ELECTRON_DIR) dev

# Clean Electron build artifacts (keeps node_modules + native/)
electron-clean:
	rm -rf $(ELECTRON_DIR)/out $(ELECTRON_DIR)/dist \
	       $(ELECTRON_RESOURCES)/opencode-cli $(ELECTRON_RESOURCES)/icons
	@echo "Cleaned Electron build artifacts."

# =============================================================================
# Electron debug convenience targets — equivalent to `make <target> CLI_DEBUG=1`
#
# Target-specific CLI_DEBUG propagates through the full prerequisite chain
# (electron-install → electron-package → electron-build → electron-cli),
# so the embedded CLI sidecar is built with --debug (sourcemaps + inspector).
# Use `make electron-install-debug` for a drop-in debug install workflow.
#
# Why this works: $(CLI_DEBUG_FLAG) is defined with `=` (recursive), so it
# re-expands when the recipe runs and picks up target-specific CLI_DEBUG.
# =============================================================================

electron-cli-debug: CLI_DEBUG := 1
electron-cli-debug: electron-cli

electron-build-debug: CLI_DEBUG := 1
electron-build-debug: electron-build

electron-package-debug: CLI_DEBUG := 1
electron-package-debug: electron-package

electron-install-debug: CLI_DEBUG := 1
electron-install-debug: electron-install
