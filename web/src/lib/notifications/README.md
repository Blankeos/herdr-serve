# Web Push notifications — parent integration

Real background push for agent completion (desktop + installed iOS web app).
New files only — `App.tsx` / `styles.css` / `api.ts` are untouched; the parent
mounts the component and reads the deep link.

## What was added

Server (Go, `SherClockHolmes/webpush-go` v1.4.0 — maintained VAPID + RFC 8291
`aes128gcm` sender, same transport Chrome/Firefox/Safari speak):

- `internal/push/{service,transition,http}.go` — VAPID keys + subscriptions
  persisted to `$HERDR_SERVE_PUSH_FILE` or
  `<UserConfigDir>/herdr-serve/push.json` (dir `0700`, file `0600`);
  authorized `GET /api/push/public-key`, `POST /api/push/subscribe`,
  `POST /api/push/unsubscribe` (idempotent); background monitor polling
  `Snapshot()` every 10s, notifying only on `working → done|idle|blocked`
  (first sight baselines — no initial flood; removals pruned, never notified);
  payloads are metadata only (kind/title/workspace/status/ids + `/?agent=` URL,
  never prompt text or terminal output); per-subscription 10s timeout and
  automatic removal of expired endpoints (HTTP 404/410), TTL 24h.
- `internal/server/push_routes.go` (+ 3-line wiring in `server.go`) —
  mounts the three routes behind the existing `requireAuth` gate and starts
  the monitor. Separate file so concurrent route work (uploads agent) merges
  cleanly. Push init failure only disables push, never the API.
- Tests: `internal/push/*_test.go` (transition semantics, persistence perms,
  endpoint validation, no-flood, send-on-transition, expiry pruning, timeout
  bound) and `internal/server/push_routes_test.go` (auth gating + round trip).

Web (no `App.tsx`/`styles.css`/`api.ts` edits):

- `web/public/push-sw.js` → served as `/push-sw.js` (scope `/`). On `push`
  always `showNotification` (Apple has no silent push); on
  `notificationclick` focuses/navigates an existing window or opens
  `/?agent=<id>`. Cross-browser options only (iOS ignores the rest).
- `web/public/manifest.webmanifest` + icons were already added by the
  branding pass; this change adds the missing PNG/ICO bytes
  (`icon-192/512`, `icon-maskable-512`, `apple-touch-icon`, `favicon-32/ico`)
  so installability checks pass. No manifest edit needed.
- `web/src/lib/notifications/{push.ts,PushSettings.tsx,index.ts}` — public
  module. `push.ts` owns SW registration, VAPID subscribe, authed fetch
  (same `herdr_serve_token` key, no `api.ts` import), support probing,
  `consumeAgentDeepLink()`. `PushSettings.tsx` is the mountable Solid
  component (inline styles only): permission is requested ONLY from its
  Enable button (user gesture, iOS-safe), with graceful
  unsupported/insecure-context UI and iOS Home-Screen guidance.

## Parent integration (2 steps, ~5 lines)

```tsx
import { PushSettings, consumeAgentDeepLink } from "./lib/notifications";

// 1. Mount wherever settings live (no CSS import needed):
<PushSettings />

// 2. On launch, honor the notification deep link:
const deepId = consumeAgentDeepLink(); // e.g. "term_abc123" | null
if (deepId) selectAgent(deepId);       // match terminal_id || pane_id
```

`selectAgent` should match `terminal_id || pane_id` (the server deep-links
`terminal_id` first, `pane_id` fallback — same as the sidebar selection).

## Behavior contract

- Background: SW delivery works with no tab open (desktop) and with the
  installed iOS web app closed (iOS 16.4+, Home Screen install, HTTPS).
  Foreground polling is unchanged.
- iOS requirements surfaced in UI: installed app + HTTPS + user gesture.
  `ensurePushSubscribed()` throws a human-readable message otherwise.
- No sensitive content in notifications; one push per transition (no repeats
  while stable); expired endpoints pruned automatically.
- `push-sw.js` must stay at the site root with `Cache-Control: no-cache`
  (wired in `push_routes.go`); keep `start_url: "/"` so `/?agent=` deep links
  open in scope.

## Manual verification

1. `just ui && go run ./cmd/herdr-serve serve --mode local -y` (or tunnel for HTTPS).
2. Open UI → mount `<PushSettings/>` → Enable (grant permission).
3. Start an agent, wait for `working`, let it finish → notification arrives;
   closed-tab / installed-app taps open `/?agent=<id>`.
4. `go test ./internal/push/ ./internal/server/ -run Push` for logic + routes.
