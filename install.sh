#!/usr/bin/env bash
set -euo pipefail

# Install the latest herdr-serve release binary for the current platform.
# Usage:
#   curl -sSL https://raw.githubusercontent.com/Blankeos/herdr-serve/main/install.sh | sh
#   curl -sSL https://raw.githubusercontent.com/Blankeos/herdr-serve/main/install.sh | sh -s -- --version 0.1.0

REPO="Blankeos/herdr-serve"
BINARY="herdr-serve"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version|-v)
      VERSION="${2#v}"
      shift 2
      ;;
    --dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) target_os="apple-darwin" ;;
  Linux) target_os="unknown-linux-gnu" ;;
  *)
    echo "Unsupported OS: $os" >&2
    exit 1
    ;;
esac

case "$arch" in
  x86_64|amd64) target_arch="x86_64" ;;
  arm64|aarch64) target_arch="aarch64" ;;
  *)
    echo "Unsupported architecture: $arch" >&2
    exit 1
    ;;
esac

target="${target_arch}-${target_os}"

if [[ -z "$VERSION" ]]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep -o '"tag_name": *"[^"]*"' \
    | head -1 \
    | sed 's/.*"v\{0,1\}\([^"]*\)".*/\1/')"
fi

VERSION="${VERSION#v}"
asset="${BINARY}-${target}.tar.xz"
url="https://github.com/${REPO}/releases/download/v${VERSION}/${asset}"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "Downloading ${url}..."
curl -fsSL "$url" -o "${tmpdir}/${asset}"
tar -xf "${tmpdir}/${asset}" -C "$tmpdir"

mkdir -p "$INSTALL_DIR"
if [[ -w "$INSTALL_DIR" ]]; then
  install -m 755 "${tmpdir}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
else
  sudo install -m 755 "${tmpdir}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
fi

echo "✅ Installed ${BINARY} v${VERSION} -> ${INSTALL_DIR}/${BINARY}"
