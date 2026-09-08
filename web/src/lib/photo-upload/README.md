# Photo upload — parent integration

Native iOS camera / photo-library uploads for the shortcuts footer (dock).
New files only — `App.tsx` / `styles.css` / `api.ts` are untouched; the parent
mounts the component.

## What was added

Server (Go, stdlib only):

- `internal/server/upload_routes.go` — authorized `POST /api/uploads`
  (multipart field `"file"`, aliases `"photo"`/`"image"`/`"upload"` accepted)
  behind the existing `requireAuth` gate (Bearer token or `?token=`, same as
  every other `/api/*` route). Bounded size (`maxUploadBytes = 15 MiB`,
  whole-body cap 16 MiB via `http.MaxBytesReader` + `LimitReader` + header
  check → `413` on overflow). Image validation is content-sniff based:
  `net/http` sniff for `image/*` plus manual HEIC/HEIF/AVIF `ftyp`-brand
  sniffing (Go + `DetectContentType` don't recognize HEIC, so `isHEIFImage`
  checks `ftyp` + brands `heic/heix/hevc/hevx/heim/heis/hevm/hevs/mif1/msf1/
  avif/avis`). Persists to `DefaultUploadDir()` (`$HERDR_SERVE_UPLOAD_DIR`
  or `<UserConfigDir>/herdr-serve/uploads`, dir `0700`, file `0600`,
  `O_EXCL` random name `photo-<timestamp>-<hex>.<ext>`) so the file is
  private + survives restarts. Returns
  `{ok:true, path:<absolute>, filename, bytes, contentType}`.
- `internal/server/server.go` (+1 line) — `s.mountUploadRoutes()` next to
  `s.mountPushRoutes()`; separate file so concurrent push work merges cleanly.
- Tests: `internal/server/upload_routes_test.go` (auth gating, missing file,
  non-image rejection, PNG/JPEG/HEIC acceptance, oversize `413`, private
  persisted file with `0600`/`0700` + absolute path + byte-identical content,
  method-not-allowed, field-alias handling).

Web (no `App.tsx`/`styles.css`/`api.ts` edits):

- `web/src/lib/photo-upload/upload.ts` — `uploadPhoto(file)` (same
  `herdr_serve_token` key as `api.ts#getToken`, no `api.ts` import; client
  pre-checks size/type, server re-validates), `quotePathForShell(path)`
  (single-quote escaping), `MAX_UPLOAD_BYTES`/`UPLOAD_ENDPOINT`.
- `web/src/lib/photo-upload/PhotoUpload.tsx` — mountable Solid component,
  inline styles only. Two native inputs (`accept="image/*"` both;
  `capture="environment"` ONLY on Take photo → rear camera on iOS, plain
  input → Photo library). Captures `selectedId` at picker opening
  (`capturedId`) so mid-upload selection changes can't misroute the path;
  uploads, then calls `onInsertText(quoted + " ", capturedId)` with the
  shell-quoted absolute path and NO trailing Enter. Loading (`Uploading…`
  + disabled buttons) and error states are explicit and cleared on each new
  attempt (`setError("")` on pick + on success).

## Parent integration (dock, ~5 lines)

```tsx
import { PhotoUpload } from "./lib/photo-upload";

// Inside the dock, next to the shortcut chips (e.g. in .keybar-scroll):
//  - selected() is terminal_id || pane_id (same value the sidebar uses).
//  - enqueueTerminalInput is the durable WS text path ("terminal.input").
//    Do NOT use sendKeys (/api/agents/{id}/keys): it only accepts logical
//    key names ("esc", "ctrl+c", "y", …), not arbitrary path text.
<PhotoUpload
  selectedId={selected()}
  onInsertText={(text) => enqueueTerminalInput(text)}
  disabled={conn() !== "live"}
/>
```

If you need the captured terminal id (e.g. selection may have moved), use
the second arg: `onInsertText={(text, termId) => …}` — it is the id captured
when the picker opened, not the live selection.

## Why terminal input, not sendKeys (inspected)

- `web/src/api.ts#sendKeys(id, keys)` → `POST /api/agents/{id}/keys`
  `{keys:[…]}` → `herdr agent send-keys <target> <key>…`, which validates
  keys server-side (logical names only). A filesystem path is not a key.
- `web/src/App.tsx#enqueueTerminalInput(text)` → WS
  `{"type":"terminal.input","text":t}` → `internal/relay` →
  `herdr terminal session control --takeover` stdin. Raw text, no Enter
  unless you append `\r`. `queueSoftInsert` (soft keyboard) uses the same
  queue, which coalesces + survives reconnects — the upload path reuses it
  via the `onInsertText` callback.
- Auth (inspected `api.ts` + `internal/auth/auth.go`): `getToken()` reads
  `localStorage["herdr_serve_token"]`; requests send
  `Authorization: Bearer <token>` (or `?token=` for WS). `uploadPhoto`
  does the same header without importing `api.ts`.

## Behavior contract

- Take photo opens the camera (iOS `capture="environment"`); Photo library
  opens the picker. Both require a selected terminal (buttons disabled +
  `"Select a terminal first"` otherwise).
- Upload is authorized multipart, bounded (client + server 15 MiB → clear
  `"Photo too large…"` / `413` errors), image-validated incl. HEIC.
- Inserted text is `'abs path' + " "` (quoted, trailing space, WITHOUT
  `\r`/`\n`) into the picker-open-time terminal via the parent's terminal
  input queue.
- Private persisted file: `0700` dir, `0600` file under the server user's
  config dir; absolute path returned to the client.

## Manual verification

1. `go test ./internal/server/ -run Upload -v` (backend validations).
2. `just ui` / `vite build`, mount per above in the dock.
3. On iPhone (or devtools mobile): tap Take photo → snap → path appears in
   the selected terminal with no newline; tap Photo library → pick → same.
4. No-terminal state shows the hint; airplane-mode upload shows the network
   error; oversize/non-image files show the validation error.
