/**
 * Photo upload client for herdr-serve.
 *
 * Self-contained: does NOT import ../../api (parent integrates without
 * touching api.ts). Auth reuses the same localStorage token key the main
 * app uses (`herdr_serve_token` — see web/src/api.ts `getToken()`).
 *
 * Flow:
 *   1. User picks an image via native iOS file inputs (accept="image/*").
 *   2. `uploadPhoto(file)` POSTs authorized multipart/form-data to
 *      POST /api/uploads (field "file"), bounded by MAX_UPLOAD_BYTES.
 *   3. Server validates the payload is an image (JPEG/PNG/GIF/WebP/HEIC/
 *      HEIF/AVIF/BMP/TIFF — HEIC via ftyp-brand sniffing since neither
 *      Go's image/* nor net/http sniff HEIC), persists it privately
 *      (0700 dir, 0600 file) and returns the absolute path.
 *   4. Caller inserts `quotePathForShell(path)` into the selected terminal
 *      via the terminal WebSocket text path (enqueueTerminalInput /
 *      {"type":"terminal.input","text"}) WITHOUT appending Enter (\r).
 *      NOTE: `sendKeys` (/api/agents/{id}/keys) is the WRONG channel — it
 *      only accepts logical key names ("esc", "ctrl+c", "y", …), not
 *      arbitrary path text. See PhotoUpload.tsx + README.md.
 */

const TOKEN_KEY = "herdr_serve_token";

export const UPLOAD_ENDPOINT = "/api/uploads";

/** Must mirror the server's maxUploadBytes (15 MiB). */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export type UploadResult = {
  ok: boolean;
  /** Absolute server-local path, e.g. "/Users/x/.config/herdr-serve/uploads/photo-….heic". */
  path: string;
  filename: string;
  bytes: number;
  contentType: string;
};

function getAuthToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

/** Client-side pre-check; the server re-validates authoritatively. */
export function isImageLike(file: File): boolean {
  try {
    const t = (file.type || "").toLowerCase();
    if (t) return t.startsWith("image/");
    // iOS sometimes reports an empty type for HEIC — fall back to extension.
    const name = (file.name || "").toLowerCase();
    return /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tif?f)$/.test(name);
  } catch {
    return false;
  }
}

/**
 * Shell-quote an absolute path for POSIX shells (sh/bash/zsh/fish-compatible
 * for the common case): wrap in single quotes, escaping embedded quotes as
 * '\''. Example: /tmp/a'b/c.png -> '/tmp/a'\''b/c.png'.
 */
export function quotePathForShell(path: string): string {
  return `'${String(path).replace(/'/g, `'\\''`)}'`;
}

export async function uploadPhoto(file: File): Promise<UploadResult> {
  if (!file) throw new Error("No file selected");
  if (file.size <= 0) throw new Error("Empty file");
  if (file.size > MAX_UPLOAD_BYTES) {
    const mb = (MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0);
    throw new Error(`Photo too large (${(file.size / (1024 * 1024)).toFixed(1)} MB, max ${mb} MB)`);
  }
  if (!isImageLike(file)) {
    throw new Error("Not an image — choose a photo (JPEG/PNG/HEIC)");
  }
  const form = new FormData();
  // Canonical field name the server prefers; it also accepts photo/image/upload.
  form.append("file", file, file.name || "photo.jpg");

  const headers: Record<string, string> = {};
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  // Do NOT set Content-Type: the browser adds the multipart boundary.

  let res: Response;
  try {
    res = await fetch(UPLOAD_ENDPOINT, { method: "POST", headers, body: form });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : "Upload failed (network)");
  }
  const body = (await res.json().catch(() => ({}))) as Partial<UploadResult> & {
    error?: string;
  };
  if (!res.ok) {
    throw new Error(body.error || res.statusText || "Upload failed");
  }
  if (!body || typeof body.path !== "string" || !body.path) {
    throw new Error("Upload failed (bad server response)");
  }
  return {
    ok: true,
    path: body.path,
    filename: typeof body.filename === "string" ? body.filename : "",
    bytes: typeof body.bytes === "number" ? body.bytes : file.size,
    contentType: typeof body.contentType === "string" ? body.contentType : file.type || "",
  };
}
