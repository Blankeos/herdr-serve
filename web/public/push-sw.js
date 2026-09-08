/* herdr-serve web push service worker.
 *
 * Genuinely background: the browser starts this worker on incoming push
 * even when no herdr tab is open (desktop) or when the installed iOS web
 * app is closed (iOS 16.4+, installed to Home Screen, HTTPS origin).
 *
 * Payload (encrypted JSON from the Go server, metadata only — never prompt
 * text or terminal output):
 *   { title, body, agentId, paneId, terminalId, status, kind, workspace, url }
 * where url is "/?agent=<terminal_id>" — the app deep link the parent reads
 * to select/focus the agent (see web/src/lib/notifications/README.md).
 *
 * Notes:
 * - Every push MUST show a notification: Apple has no silent web push and
 *   some browsers kill workers that skip showNotification. We always show.
 * - Keep NotificationOptions to the cross-browser subset (title/body/tag/
 *   icon/badge/data). iOS ignores the rest (actions/vibrate/silent/etc.).
 * - notificationclick focuses an existing herdr window (navigating it to the
 *   agent deep link) or opens one. Works for desktop + installed iOS webapp.
 */

self.addEventListener("push", (event) => {
  /** @type {{title?:string,body?:string,agentId?:string,paneId?:string,url?:string}} */
  let data = {};
  try {
    if (event.data) {
      try {
        data = event.data.json();
      } catch {
        try {
          data = { body: event.data.text() };
        } catch {
          data = {};
        }
      }
    }
  } catch {
    data = {};
  }

  const title =
    typeof data.title === "string" && data.title.trim()
      ? data.title.trim().slice(0, 80)
      : "herdr-serve";
  const body =
    typeof data.body === "string" && data.body.trim()
      ? data.body.trim().slice(0, 160)
      : "Agent update — tap to open.";

  let url = "/";
  if (typeof data.url === "string" && data.url.startsWith("/")) {
    url = data.url.slice(0, 256);
  } else if (typeof data.agentId === "string" && data.agentId) {
    url = "/?agent=" + encodeURIComponent(data.agentId.slice(0, 128));
  }

  const tag =
    "herdr-" +
    String(data.paneId || data.agentId || "agent").slice(0, 64);

  const options = {
    body,
    tag,
    renotify: true,
    data: { url },
    icon: "/icon-192.png",
    badge: "/icon-192.png",
  };

  event.waitUntil(
    self.registration
      .showNotification(title, options)
      .catch(() => self.registration.showNotification(title, { body })),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw =
    event.notification &&
    event.notification.data &&
    typeof event.notification.data.url === "string"
      ? event.notification.data.url
      : "/";
  const url = raw.startsWith("/") ? raw : "/";

  event.waitUntil(
    (async () => {
      try {
        const wins = await clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        const target = new URL(url, self.location.origin);
        for (const win of wins) {
          try {
            const cur = new URL(win.url);
            if (cur.origin === target.origin) {
              if ("navigate" in win && typeof win.navigate === "function") {
                await win.navigate(target.href);
              }
              return win.focus();
            }
          } catch {
            /* try next window */
          }
        }
      } catch {
        /* fall through to openWindow */
      }
      try {
        return await clients.openWindow(url);
      } catch {
        return undefined;
      }
    })(),
  );
});

// Suppress noisy "unhandled" errors if a push arrives with no data.
self.addEventListener("pushsubscriptionchange", () => {
  // The app re-subscribes on next launch (see PushSettings component).
});
