set shell := ["bash", "-cu"]

default:
  @just --list

# Install Go + UI deps
setup:
  go mod tidy
  cd web && npm install

# Build Solid UI into web/dist (embedded by Go)
ui:
  cd web && npm run build

# Build the herdr-serve binary (UI must be built first for embed)
build: ui
  go build -ldflags "-X main.version=$(cat VERSION)" -o bin/herdr-serve ./cmd/herdr-serve

# Run with wizard (TTY) or pass args after --
serve *args:
  go run -ldflags "-X main.version=$(cat VERSION)" ./cmd/herdr-serve serve {{args}}

# Non-interactive network mode
serve-network port="7700":
  go run -ldflags "-X main.version=$(cat VERSION)" ./cmd/herdr-serve serve --mode network --port {{port}} -y

# Non-interactive trycloudflare tunnel
serve-tunnel port="7700":
  go run -ldflags "-X main.version=$(cat VERSION)" ./cmd/herdr-serve serve --mode tunnel --port {{port}} -y

# Dev: Go API on :7700 + Vite on :5173 (proxied /api)
dev:
  #!/usr/bin/env bash
  set -euo pipefail
  go run -ldflags "-X main.version=$(cat VERSION)" ./cmd/herdr-serve serve --mode local --port 7700 -y &
  api=$!
  trap 'kill $api 2>/dev/null || true' EXIT
  cd web && npm run dev -- --host 0.0.0.0

# Format / vet
check:
  go vet ./...
  cd web && npm run build

# Clean build artifacts
clean:
  rm -rf bin web/dist
  mkdir -p web/dist
  touch web/dist/.gitkeep

# Release: bump VERSION + npm, changelog, commit, tag, push
tag:
  ./tag_and_release.sh
