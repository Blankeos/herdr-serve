export const STATUS_REFRESH_INTERVAL_MS = 2500;

/** Refresh metadata even when terminal output continues without lifecycle events.
 * Keep only one refresh running, pause hidden pages, and catch up on resume.
 */
export function startStatusRefresh(refresh: () => Promise<unknown>): () => void {
  let stopped = false;
  let inFlight = false;
  let resumePending = false;
  let timer: number | undefined;
  const isVisible = () => document.visibilityState !== "hidden";

  const clearTimer = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };
  const run = async () => {
    clearTimer();
    if (stopped || !isVisible()) return;
    if (inFlight) {
      resumePending = true;
      return;
    }
    inFlight = true;
    try {
      await refresh();
    } catch {
      // The caller reports failures; a rejected refresh must not stop retries.
    } finally {
      inFlight = false;
      if (!stopped && isVisible()) {
        const delay = resumePending ? 0 : STATUS_REFRESH_INTERVAL_MS;
        resumePending = false;
        timer = window.setTimeout(() => void run(), delay);
      }
    }
  };
  const onResume = () => {
    if (!isVisible()) clearTimer();
    else void run();
  };

  document.addEventListener("visibilitychange", onResume);
  window.addEventListener("pageshow", onResume);
  window.addEventListener("online", onResume);
  void run();

  return () => {
    stopped = true;
    clearTimer();
    document.removeEventListener("visibilitychange", onResume);
    window.removeEventListener("pageshow", onResume);
    window.removeEventListener("online", onResume);
  };
}
