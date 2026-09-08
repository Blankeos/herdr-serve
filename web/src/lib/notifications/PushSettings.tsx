import { Show, createSignal, onMount } from "solid-js";
import {
  consumeAgentDeepLink,
  disablePush,
  ensurePushSubscribed,
  getPushState,
  type PushState,
} from "./push";

export type { PushState };
export { consumeAgentDeepLink };

/**
 * PushSettings — drop-in Solid component the parent mounts (e.g. in Settings).
 *
 *   import { PushSettings } from "./lib/notifications";
 *   ...
 *   <PushSettings />
 *
 * - Permission is requested ONLY from the Enable button (user gesture),
 *   satisfying iOS / Chrome gesture requirements.
 * - Shows graceful states for unsupported browsers, insecure contexts
 *   (HTTP LAN without TLS), and iOS Home-Screen installation guidance.
 * - Uses inline styles only (no styles.css dependency).
 * - After a notification tap the service worker opens `/?agent=<id>`;
 *   the parent should call `consumeAgentDeepLink()` on launch and select
 *   the matching agent (see ./README.md).
 */
export function PushSettings() {
  const [state, setState] = createSignal<PushState | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [note, setNote] = createSignal("");

  const refresh = async () => {
    try {
      setState(await getPushState());
    } catch {
      /* keep last state */
    }
  };

  onMount(() => {
    void refresh();
    // If we were opened from a notification tap, surface which agent.
    const deep = consumeAgentDeepLink();
    if (deep) setNote(`Opened from notification for agent ${deep}.`);
  });

  const enable = async () => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const { endpoint } = await ensurePushSubscribed();
      setNote(
        endpoint
          ? "Notifications on — you'll get agent completions even with the app closed."
          : "Notifications on.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const disable = async () => {
    setBusy(true);
    setError("");
    try {
      await disablePush();
      setNote("Notifications off for this device.");
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const card: Record<string, string> = {
    border: "1px solid rgba(255,255,255,0.12)",
    "border-radius": "0.75rem",
    padding: "0.9rem 1rem",
    background: "rgba(255,255,255,0.03)",
    display: "flex",
    "flex-direction": "column",
    gap: "0.6rem",
    "max-width": "26rem",
  };
  const title: Record<string, string> = {
    margin: "0",
    "font-size": "0.95rem",
    "font-weight": "650",
  };
  const desc: Record<string, string> = {
    margin: "0",
    "font-size": "0.82rem",
    opacity: "0.75",
    "line-height": "1.45",
  };
  const btn = (primary: boolean): Record<string, string> => ({
    appearance: "none",
    border: primary ? "none" : "1px solid rgba(255,255,255,0.2)",
    "border-radius": "0.55rem",
    padding: "0.55rem 0.9rem",
    "font-size": "0.85rem",
    "font-weight": "600",
    cursor: busy() ? "wait" : "pointer",
    opacity: busy() ? "0.6" : "1",
    background: primary ? "#6c8ed8" : "transparent",
    color: primary ? "#0d1117" : "inherit",
  });
  const msg = (bad: boolean): Record<string, string> => ({
    margin: "0",
    "font-size": "0.8rem",
    "line-height": "1.45",
    color: bad ? "#f0883e" : "#7ee787",
    "white-space": "pre-line",
  });
  const steps: Record<string, string> = {
    margin: "0.2rem 0 0",
    "padding-left": "1.1rem",
    "font-size": "0.8rem",
    opacity: "0.85",
    "line-height": "1.6",
  };

  return (
    <div style={card}>
      <h3 style={title}>Notifications</h3>
      <p style={desc}>
        Background push for agent completions (finished / idle / needs
        attention) — works with the app closed. Tapping a notification
        deep-links to the agent.
      </p>

      <Show when={state() === null}>
        <p style={desc}>Checking notification support…</p>
      </Show>

      <Show when={state() !== null}>
        <Show
          when={state()!.supported}
          fallback={
            <div>
              <Show
                when={state()!.reason === "insecure-context"}
                fallback={
                  <p style={msg(true)}>
                    Push isn't available in this browser
                    {state()!.ios
                      ? " — on iPhone/iPad install the app first (Share → Add to Home Screen) and open it from the Home Screen."
                      : " (needs Service Worker + PushManager). Try Chrome / Edge / Safari."}
                  </p>
                }
              >
                <p style={msg(true)}>
                  Push needs a secure context — open herdr-serve over HTTPS
                  (tunnel mode) or http://localhost. Plain-http LAN/IP pages
                  can't subscribe.
                </p>
              </Show>
            </div>
          }
        >
          <Show when={state()!.needsInstall}>
            <div>
              <p style={msg(true)}>
                iPhone/iPad: web push works only in the installed app (iOS
                16.4+).
              </p>
              <ol style={steps}>
                <li>Open this page in Safari.</li>
                <li>Share → Add to Home Screen → Add.</li>
                <li>Open herdr-serve from the Home Screen.</li>
                <li>Come back here and tap Enable.</li>
              </ol>
            </div>
          </Show>

          <Show when={state()!.permission === "denied"}>
            <p style={msg(true)}>
              Notifications are blocked. Allow them in the browser / OS
              settings
              {state()!.ios
                ? " (Settings → the installed herdr-serve app → Notifications)"
                : ""}
              , then reload and try again.
            </p>
          </Show>

          <div style={{ display: "flex", gap: "0.5rem", "flex-wrap": "wrap" }}>
            <Show
              when={!state()!.subscribed}
              fallback={
                <button
                  style={btn(false)}
                  disabled={busy()}
                  onClick={disable}
                >
                  {busy() ? "Working…" : "Disable"}
                </button>
              }
            >
              <button
                style={btn(true)}
                disabled={busy() || state()!.needsInstall}
                onClick={enable}
                title={
                  state()!.needsInstall
                    ? "Install to Home Screen first"
                    : "Enable background notifications"
                }
              >
                {busy() ? "Enabling…" : "Enable"}
              </button>
            </Show>
          </div>

          <Show when={state()!.subscribed}>
            <p style={desc}>
              On for this device
              {state()!.standalone ? " (installed app)" : ""}. New
              working → done / idle / blocked transitions push once.
            </p>
          </Show>
        </Show>

        <Show when={error()}>
          <p style={msg(true)}>{error()}</p>
        </Show>
        <Show when={note()}>
          <p style={msg(false)}>{note()}</p>
        </Show>
      </Show>
    </div>
  );
}

export default PushSettings;
