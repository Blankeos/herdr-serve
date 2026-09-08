/**
 * Web Push client for herdr-serve agent-completion notifications.
 *
 * Genuinely background: subscription + service worker (`/push-sw.js`) let the
 * browser / installed iOS web app show notifications even with no tab open.
 * The Go server watches `herdr api snapshot` for working -> done/idle/blocked
 * transitions and pushes metadata-only payloads (no prompt text / output).
 *
 * This module is intentionally self-contained: it does NOT import ../api
 * (parent integrates without touching api.ts). Auth reuses the same
 * localStorage token key the main app uses.
 *
 * Public API (also re-exported from ./index):
 *   pushSupport()        capability / environment report for UI gating
 *   getPushState()       current permission + subscription snapshot
 *   ensurePushSubscribed()  MUST be called from a user gesture (button click)
 *   disablePush()        unsubscribe + notify server (user gesture recommended)
 *   consumeAgentDeepLink() read/clear `?agent=<id>` from the SW deep link
 */

const TOKEN_KEY = "herdr_serve_token";
const SW_PATH = "/push-sw.js";

export type PushPermission = "granted" | "denied" | "default";

export type PushSupport = {
  /** ServiceWorker + PushManager + Notification all present. */
  supported: boolean;
  /** Why unsupported, for graceful UI messaging. */
  reason: "ok" | "no-service-worker" | "no-push-manager" | "no-notification" | "insecure-context";
  /** window.isSecureContext (push requires HTTPS or localhost). */
  secureContext: boolean;
  /** True on iPhone/iPad (WebKit). */
  ios: boolean;
  /** True when running as installed (Home Screen) web app. */
  standalone: boolean;
  /** iOS Safari requires Home Screen install before PushManager exists. */
  needsInstall: boolean;
};

export type PushState = PushSupport & {
  permission: PushPermission;
  subscribed: boolean;
  endpoint: string | null;
};

function getAuthToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

async function authed<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (body as { error?: string }).error || res.statusText || "request failed",
    );
  }
  return body as T;
}

export function isIOS(): boolean {
  try {
    const ua = navigator.userAgent || "";
    const iDevice = /iPad|iPhone|iPod/.test(ua);
    // iPadOS 13+ reports Macintosh + touch points.
    const iPadOS =
      navigator.platform === "MacIntel" &&
      typeof navigator.maxTouchPoints === "number" &&
      navigator.maxTouchPoints > 1;
    return iDevice || iPadOS;
  } catch {
    return false;
  }
}

export function isStandalone(): boolean {
  try {
    if (
      window.matchMedia &&
      window.matchMedia("(display-mode: standalone)").matches
    ) {
      return true;
    }
    // iOS Safari legacy flag.
    const nav = navigator as Navigator & { standalone?: boolean };
    if (typeof nav.standalone === "boolean" && nav.standalone) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** Capability report used to render graceful unsupported/insecure/iOS UI. */
export function pushSupport(): PushSupport {
  const secureContext =
    typeof window !== "undefined" ? window.isSecureContext === true : false;
  const hasSW =
    typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const hasPush =
    typeof window !== "undefined" && "PushManager" in window;
  const hasNotif =
    typeof window !== "undefined" && "Notification" in window;
  let reason: PushSupport["reason"] = "ok";
  if (!hasSW) reason = "no-service-worker";
  else if (!hasPush) reason = "no-push-manager";
  else if (!hasNotif) reason = "no-notification";
  else if (!secureContext) reason = "insecure-context";
  const ios = isIOS();
  const standalone = isStandalone();
  return {
    supported: reason === "ok",
    reason,
    secureContext,
    ios,
    standalone,
    needsInstall: ios && !standalone,
  };
}

/** Current permission + subscription snapshot (no permission prompt). */
export async function getPushState(): Promise<PushState> {
  const support = pushSupport();
  let permission: PushPermission = "default";
  try {
    if ("Notification" in window) {
      permission = Notification.permission as PushPermission;
    }
  } catch {
    /* ignore */
  }
  let subscribed = false;
  let endpoint: string | null = null;
  if (support.supported) {
    try {
      const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        subscribed = true;
        endpoint = sub.endpoint || null;
      }
    } catch {
      /* treat as unsubscribed */
    }
  }
  return { ...support, permission, subscribed, endpoint };
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Subscribe for background push. MUST be called from a user gesture
 * (button click) — browsers (and iOS in particular) reject
 * Notification.requestPermission() outside one.
 *
 * Steps: register SW -> request permission -> PushManager.subscribe ->
 * POST /api/push/subscribe. Throws with a human-readable message on failure.
 */
export async function ensurePushSubscribed(): Promise<{ endpoint: string }> {
  const support = pushSupport();
  if (support.needsInstall) {
    throw new Error(
      "Install herdr-serve to your Home Screen first (Share → Add to Home Screen), then enable notifications from the installed app.",
    );
  }
  if (!support.supported) {
    if (support.reason === "insecure-context") {
      throw new Error(
        "Push needs a secure context — use HTTPS or http://localhost.",
      );
    }
    throw new Error("Push notifications are not supported in this browser.");
  }

  const reg = await navigator.serviceWorker.register(SW_PATH, {
    scope: "/",
  });
  // Ensure the fresh worker takes over without a reload race.
  try {
    await navigator.serviceWorker.ready;
  } catch {
    /* ignore */
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "Notifications are blocked — allow them in the browser / system settings, then try again."
        : "Permission dismissed — tap Enable again to allow notifications.",
    );
  }

  const { publicKey } = await authed<{ publicKey: string }>(
    "/api/push/public-key",
  );
  if (!publicKey) throw new Error("Server has no push key (push disabled).");

  const existing = await reg.pushManager.getSubscription().catch(() => null);
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    }));

  const json = sub.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("Browser produced an invalid subscription.");
  }
  await authed("/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    }),
  });
  return { endpoint: json.endpoint };
}

/**
 * Disable background push: unsubscribe locally + remove the server endpoint.
 * Best called from a user gesture too (async work after click is fine).
 */
export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
    const sub = await reg?.pushManager.getSubscription().catch(() => null);
    const endpoint = sub?.endpoint || null;
    if (sub) {
      try {
        await sub.unsubscribe();
      } catch {
        /* continue to server cleanup */
      }
    }
    if (endpoint) {
      await authed("/api/push/unsubscribe", {
        method: "POST",
        body: JSON.stringify({ endpoint }),
      }).catch(() => undefined);
    }
  } catch {
    /* idempotent — disabling never throws */
  }
}

/**
 * Read the service-worker deep link (`/?agent=<id>`) after a notification
 * tap. Returns the agent id (terminal_id, pane_id fallback) or null. Clears
 * the query param so refreshes don't re-trigger selection.
 */
export function consumeAgentDeepLink(): string | null {
  try {
    const u = new URL(window.location.href);
    const id = (u.searchParams.get("agent") || "").trim();
    if (!id) return null;
    u.searchParams.delete("agent");
    window.history.replaceState(
      null,
      "",
      u.pathname + (u.search ? "?" + u.searchParams.toString() : "") + u.hash,
    );
    return id;
  } catch {
    return null;
  }
}
