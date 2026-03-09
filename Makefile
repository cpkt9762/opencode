SIGN_IDENTITY ?= OpenCode Dev
DESKTOP_DIR   := packages/desktop
OPENCODE_DIR  := packages/opencode
PROD_CONF     := src-tauri/tauri.prod.conf.json
BUNDLE_DIR    := $(DESKTOP_DIR)/src-tauri/target/release/bundle/macos
SIDECAR_DIR   := $(DESKTOP_DIR)/src-tauri/sidecars
APP_NAME      := OpenCode.app
INSTALL_DIR   := /Applications
BUN           := $(shell which bun 2>/dev/null || echo ~/.bun/bin/bun)

# Detect macOS arch for sidecar target triple
ARCH := $(shell uname -m)
ifeq ($(ARCH),arm64)
  RUST_TARGET := aarch64-apple-darwin
  OC_DIST     := opencode-darwin-arm64
  BUILD_FLAGS :=
else
  RUST_TARGET := x86_64-apple-darwin
  OC_DIST     := opencode-darwin-x64-baseline
  BUILD_FLAGS := --baseline
endif

.PHONY: build install uninstall dev clean cli

# Build production binary (default)
all: build

# Build opencode CLI sidecar
cli:
	PATH="$(dir $(BUN)):$$PATH" OPENCODE_CHANNEL=latest $(BUN) run --cwd $(OPENCODE_DIR) build --single $(BUILD_FLAGS)
	@mkdir -p $(SIDECAR_DIR)
	cp $(OPENCODE_DIR)/dist/$(OC_DIST)/bin/opencode $(SIDECAR_DIR)/opencode-cli-$(RUST_TARGET)

# Build production binary (rebuilds CLI sidecar first)
build: cli
	PATH="$(dir $(BUN)):$$PATH" $(BUN) run --cwd $(DESKTOP_DIR) tauri build -c $(PROD_CONF)

# Sign + install to /Applications (backs up existing)
install:
	@if [ -d "$(INSTALL_DIR)/$(APP_NAME)" ] && [ ! -d "$(INSTALL_DIR)/$(APP_NAME).bak" ]; then \
		echo "Backing up $(INSTALL_DIR)/$(APP_NAME)"; \
		mv "$(INSTALL_DIR)/$(APP_NAME)" "$(INSTALL_DIR)/$(APP_NAME).bak"; \
	elif [ -d "$(INSTALL_DIR)/$(APP_NAME)" ]; then \
		rm -rf "$(INSTALL_DIR)/$(APP_NAME)"; \
	fi
	cp -r $(BUNDLE_DIR)/$(APP_NAME) $(INSTALL_DIR)/
	codesign --force --deep --sign "$(SIGN_IDENTITY)" $(INSTALL_DIR)/$(APP_NAME)
	@echo "Installed and signed. Run 'brew pin opencode-desktop' to prevent brew overwrite."

# Restore official version
uninstall:
	@if [ -d "$(INSTALL_DIR)/$(APP_NAME).bak" ]; then \
		rm -rf "$(INSTALL_DIR)/$(APP_NAME)"; \
		mv "$(INSTALL_DIR)/$(APP_NAME).bak" "$(INSTALL_DIR)/$(APP_NAME)"; \
		echo "Restored official version."; \
	else \
		echo "No backup found."; \
	fi

# Dev mode with prod config (hot reload)
dev:
	$(BUN) run --cwd $(DESKTOP_DIR) tauri dev -c $(PROD_CONF)

# Clean build artifacts
clean:
	cargo clean --manifest-path $(DESKTOP_DIR)/src-tauri/Cargo.toml
