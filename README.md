# herdr-serve

🥘 Remotely use herdr agents anywhere — no plugin, just works.

Live terminal relay to your phone — not a screenshot poller. Scan a QR, steer one agent with a real keyboard + shortcut bar.

## Install

```sh
brew install blankeos/tap/herdr-serve # Homebrew (macOS/Linux)
npm install -g herdr-serve            # or npm
bun install -g herdr-serve            # or bun
go install github.com/Blankeos/herdr-serve/cmd/herdr-serve@latest # or go
curl -sSL https://raw.githubusercontent.com/Blankeos/herdr-serve/main/install.sh | sh # or linux/macos (via curl)
```

Requires a running Herder (`herdr` on PATH). Tunnel mode also needs `cloudflared`.

## Quick start

```bash
herdr-serve serve                 # wizard
herdr-serve serve -y              # defaults (network :7700)
herdr-serve serve --mode tunnel   # trycloudflare
herdr-serve serve --mode network --port 8080
```

Wizard: network / tunnel / local → port → QR. Open the URL on your phone.

## Modes

| Mode | Bind | Reach |
| --- | --- | --- |
| `network` (default) | `0.0.0.0` | LAN + Tailscale |
| `tunnel` | `127.0.0.1` | trycloudflare |
| `local` | `127.0.0.1` | this machine |

## What you get

- Live PTY via `herdr terminal session control --takeover`
- xterm.js on the phone (full ANSI / truecolor)
- Native / hardware keyboard → selected agent pane
- Footer shortcut bar (Ctrl+C, Esc, arrows, …) — settings ⚙, localStorage + JSON import/export
- Create agents from the phone UI
- No Herder plugin required — companion CLI works alone

Not a full Herder TUI mirror. One agent at a time, steered from your phone.

## Dev

```bash
just setup
just build
just serve -y
just dev          # Go :7700 + Vite :5173 (WS proxied)
```

## Plugin (optional)

`herdr-plugin.toml` is only a convenience Start / Start (tunnel) launcher inside Herder. Nothing auto-starts.

```bash
herdr-serve serve
```

## Credits

Port of the phone-control idea from [herdr-web](https://github.com/Blankeos/herdr-web) into a standalone Go companion CLI. Same product intent, new stack — not a git fork.

## License

MIT
