import { Show, createSignal, onMount } from "solid-js";
import "./push-settings.css";
import {
  disablePush,
  ensurePushSubscribed,
  getPushState,
  type PushState,
} from "./push";

export type { PushState };

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
 * - Owns its styles (no styles.css dependency).
 * - After a notification tap the service worker opens `/?agent=<id>`; the
 *   parent (App) calls `consumeAgentDeepLink()` on launch and selects the
 *   matching agent (see ./README.md). This component never consumes the
 *   deep link so App alone owns selection.
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
    setNote("");
    try {
      await disablePush();
      setNote("Notifications off for this device.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  return (
    <section class="push-settings" aria-label="Notifications">
      <h3 class="push-settings-title">Notifications</h3>
      <p class="push-settings-description">
        Background push for agent completions (finished / idle / needs
        attention) — works with the app closed. Tapping a notification
        deep-links to the agent.
      </p>

      <Show when={state() === null}>
        <p class="push-settings-description">Checking notification support…</p>
      </Show>

      <Show when={state() !== null}>
        <Show
          when={state()!.supported}
          fallback={
            <div>
              <Show
                when={state()!.reason === "insecure-context"}
                fallback={
                  <p class="push-settings-message error">
                    Push isn't available in this browser
                    {state()!.ios
                      ? " — on iPhone/iPad install the app first (Share → Add to Home Screen) and open it from the Home Screen."
                      : " (needs Service Worker + PushManager). Try Chrome / Edge / Safari."}
                  </p>
                }
              >
                <p class="push-settings-message error">
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
              <p class="push-settings-message error">
                iPhone/iPad: web push works only in the installed app (iOS
                16.4+).
              </p>
              <ol class="push-settings-steps">
                <li>Open this page in Safari.</li>
                <li>Share → Add to Home Screen → Add.</li>
                <li>Open herdr-serve from the Home Screen.</li>
                <li>Come back here and tap Enable.</li>
              </ol>
            </div>
          </Show>

          <Show when={state()!.permission === "denied"}>
            <p class="push-settings-message error">
              Notifications are blocked. Allow them in the browser / OS
              settings
              {state()!.ios
                ? " (Settings → the installed herdr-serve app → Notifications)"
                : ""}
              , then reload and try again.
            </p>
          </Show>

          <div class="push-settings-actions">
            <Show
              when={!state()!.subscribed}
              fallback={
                <button
                  class="push-settings-button"
                  disabled={busy()}
                  onClick={disable}
                >
                  {busy() ? "Working…" : "Disable"}
                </button>
              }
            >
              <button
                class="push-settings-button"
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
            <p class="push-settings-description">
              On for this device
              {state()!.standalone ? " (installed app)" : ""}. New
              working → done / idle / blocked transitions push once.
            </p>
          </Show>
        </Show>

        <Show when={error()}>
          <p class="push-settings-message error" role="alert">{error()}</p>
        </Show>
        <Show when={note()}>
          <p class="push-settings-message success" role="status">{note()}</p>
        </Show>
      </Show>
    </section>
  );
}

export default PushSettings;
