import { Show, createSignal } from "solid-js";
import { quotePathForShell, uploadPhoto } from "./upload";

export type { UploadResult } from "./upload";
export { MAX_UPLOAD_BYTES, UPLOAD_ENDPOINT, isImageLike, quotePathForShell, uploadPhoto } from "./upload";

export type PhotoUploadProps = {
  /**
   * Currently selected terminal id (terminal_id || pane_id fallback — same
   * value the sidebar uses for `selected()`). Captured at file-picker
   * opening so a selection change mid-upload can't misroute the path.
   */
  selectedId: string;
  /**
   * Insert text into the terminal WITHOUT pressing Enter. The parent wires
   * this to its durable terminal-input path, e.g.:
   *
   *   <PhotoUpload selectedId={selected()} onInsertText={(t) => enqueueTerminalInput(t)} />
   *
   * Do NOT wire this to `sendKeys` (/api/agents/{id}/keys): sendKeys only
   * accepts logical key names ("esc", "ctrl+c", …), not arbitrary paths.
   * The second arg is the captured terminal id from picker-open time.
   */
  onInsertText?: (text: string, terminalId: string) => void;
  /** Extra disable (e.g. conn() !== "live"). Selection/loading also gate. */
  disabled?: boolean;
};

/**
 * PhotoUpload — drop-in Solid component the parent mounts in the shortcuts
 * footer (dock). New files only — App.tsx / styles.css / api.ts untouched.
 *
 *   import { PhotoUpload } from "./lib/photo-upload";
 *   <PhotoUpload selectedId={selected()} onInsertText={(t) => enqueueTerminalInput(t)} />
 *
 * - Two native inputs (accept="image/*"): one with capture="environment"
 *   (Take photo → rear camera on iOS) and one without (Photo library).
 * - Captures selectedId at picker opening; inserts the shell-quoted
 *   absolute path (+ trailing space, NO Enter) via onInsertText.
 * - Loading + error states are explicit and cleared on each new attempt.
 * - Inline styles only (no styles.css dependency) so the dock keeps working.
 */
export function PhotoUpload(props: PhotoUploadProps) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  let cameraInput: HTMLInputElement | undefined;
  let libraryInput: HTMLInputElement | undefined;
  // Captured at picker-open time; the upload+insert below uses this, never
  // the live props.selectedId (which may change while the picker is open).
  let capturedId = "";

  const isDisabled = () => Boolean(props.disabled) || busy() || !props.selectedId;

  const openPicker = (which: "camera" | "library") => {
    if (busy()) return;
    setError("");
    capturedId = (props.selectedId || "").trim();
    if (!capturedId) {
      setError("Select a terminal first");
      return;
    }
    const el = which === "camera" ? cameraInput : libraryInput;
    // Reset so picking the same photo twice still fires onChange.
    try {
      if (el) el.value = "";
    } catch {
      /* ignore */
    }
    el?.click();
  };

  const handleFiles = async (files: FileList | null | undefined) => {
    const file = files?.[0];
    if (!file) return; // picker cancelled — nothing to do, no error
    const targetId = capturedId || (props.selectedId || "").trim();
    if (!targetId) {
      setError("Select a terminal first");
      return;
    }
    if (!props.onInsertText) {
      setError("No insert handler — wire onInsertText to terminal input");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await uploadPhoto(file);
      // Shell-quoted absolute path + trailing space so the user can keep
      // typing args. Crucially NO trailing \r/\n: WITHOUT Enter.
      const quoted = `${quotePathForShell(res.path)} `;
      props.onInsertText(quoted, targetId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const row: Record<string, string> = {
    display: "flex",
    "align-items": "center",
    gap: "0.35rem",
  };
  const btn = (enabled: boolean): Record<string, string> => ({
    appearance: "none",
    border: "1px solid rgba(255,255,255,0.16)",
    "border-radius": "0.35rem",
    padding: "0.45rem 0.65rem",
    "font-size": "0.78rem",
    "font-family": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    "min-height": "2.1rem",
    cursor: enabled ? "pointer" : "default",
    opacity: enabled ? "1" : "0.45",
    background: "#121212",
    color: "inherit",
    flex: "0 0 auto",
  });
  const statusStyle: Record<string, string> = {
    margin: "0",
    "font-size": "0.75rem",
    "line-height": "1.4",
    color: "#f0883e",
    "white-space": "pre-line",
    "max-width": "16rem",
    overflow: "hidden",
    "text-overflow": "ellipsis",
  };
  const busyStyle: Record<string, string> = {
    ...statusStyle,
    color: "rgba(255,255,255,0.65)",
  };

  return (
    <div style={row} aria-label="Photo upload">
      <button
        type="button"
        style={btn(!isDisabled())}
        disabled={isDisabled()}
        title={props.selectedId ? "Take a photo and insert its path" : "Select a terminal first"}
        aria-label="Take photo"
        onClick={() => openPicker("camera")}
      >
        {busy() ? "Uploading…" : "📷 Take photo"}
      </button>
      <button
        type="button"
        style={btn(!isDisabled())}
        disabled={isDisabled()}
        title={props.selectedId ? "Pick from photo library and insert its path" : "Select a terminal first"}
        aria-label="Photo library"
        onClick={() => openPicker("library")}
      >
        {busy() ? "Uploading…" : "🖼 Photo library"}
      </button>
      <Show when={busy()}>
        <p style={busyStyle} aria-live="polite">
          Uploading…
        </p>
      </Show>
      <Show when={!busy() && error()}>
        <p style={statusStyle} role="alert">
          {error()}
        </p>
      </Show>
      {/* Native iOS inputs: accept=image/* both; capture=environment only on Take photo. */}
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        aria-hidden="true"
        tabindex={-1}
        style={{ display: "none" }}
        onChange={(e) => void handleFiles(e.currentTarget.files)}
      />
      <input
        ref={libraryInput}
        type="file"
        accept="image/*"
        aria-hidden="true"
        tabindex={-1}
        style={{ display: "none" }}
        onChange={(e) => void handleFiles(e.currentTarget.files)}
      />
    </div>
  );
}

export default PhotoUpload;
