# herdr-serve

Opt-in phone UI for Herder agents — **live terminal relay**, not a screenshot poller.

### Install

```sh
brew install blankeos/tap/herdr-serve # Homebrew (macOS/Linux)
npm install -g herdr-serve            # or npm
bun install -g herdr-serve            # or bun
go install github.com/Blankeos/herdr-serve/cmd/herdr-serve@latest # or go
curl -sSL https://raw.githubusercontent.com/Blankeos/herdr-serve/main/install.sh | sh # or linux/macos (via curl)
```

### From source

```bash
just setup
just build
./bin/herdr-serve serve
```

Wizard: network / tunnel / local → port → QR. Or pass flags.

## What it is

- Live PTY via `herdr terminal session control --takeover`
- xterm.js on the phone (full ANSI / truecolor, JetBrainsMono Nerd Font)
- Native mobile / hardware keyboard → selected agent pane
- Configurable footer shortcut bar (Ctrl+C, Esc, arrows, …) — settings ⚙ next to the title, stored in browser localStorage with JSON import/export
- Create agents from the phone UI (pick workspace → new tab → start crabcode / claude / …)
- No Herder plugin required — companion CLI works out of the box

Not a full Herder TUI mirror. One agent at a time, steered from your phone.

## Modes

| Mode | Bind | Reach |
|------|------|-------|
| `network` (default) | `0.0.0.0` | LAN + Tailscale |
| `tunnel` | `127.0.0.1` | trycloudflare |
| `local` | `127.0.0.1` | this machine |

## Usage

```bash
herdr-serve serve                 # wizard
herdr-serve serve -y              # defaults (network :7700)
herdr-serve serve --mode tunnel
herdr-serve serve --mode network --port 8080
```

## Dev

```bash
just setup
just build
just serve -y
just dev          # Go :7700 + Vite :5173 (WS proxied)
```

## Plugin (optional)

Not required. The companion CLI works alone:

```bash
./bin/herdr-serve serve
```

`herdr-plugin.toml` is only a convenience Start / Start (tunnel) launcher inside Herder. Nothing auto-starts.

## Origin

Port of the phone-control idea from [herdr-web](https://github.com/Blankeos/herdr-web) (Node/Express + Vite client) into a standalone Go companion CLI.

This is **not** a git fork — same product intent (opt-in phone UI over a live Herder PTY), new stack:

| | herdr-web | herdr-serve |
|---|---|---|
| Server | Node.js | Go (`cmd/herdr-serve`) |
| UI | `client/` Vite app | `web/` Vite app, embedded via `web/embed.go` |
| Packaging | npm package / plugin | Go binary (GitHub Releases / Homebrew / npm / `go install`) + optional `herdr-plugin.toml` |

## Requirements

- Running Herder (`herdr` on PATH)
- `--mode tunnel` → `cloudflared`
