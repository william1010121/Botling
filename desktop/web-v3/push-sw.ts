// Service worker Web Push notification formatting & click handling (M4-25, protocol v1 §18.4, Q-P1).
//
// - Lock screen shows only the bot name and "needs you" (never message text).
// - Outside text (bot name) is stripped of control characters and collapsed to one line (L-004).
// - Notification click always stays inside `/v3/` scope (never trusts arbitrary `data.url`), validates `botId`
//   against `/^[A-Za-z0-9_-]{1,64}$/` (L-006), focuses an open `/v3/` window or opens one via `clients.openWindow`.
// - Zero browser storage APIs (web-v3-sw.test.ts enforces none in sw.ts).

export const DEFAULT_PUSH_TITLE = "Botling";
export const NEEDS_YOU_BODY = "needs you";
export const FALLBACK_NEEDS_YOU_BODY = "A bot needs you";

const SAFE_BOT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface PushNotificationOptions {
  body: string;
  icon: string;
  tag: string;
  data: { url: string; botId?: string };
}

export interface FormattedPushNotification {
  title: string;
  options: PushNotificationOptions;
}

export interface PushClientLike {
  id: string;
  url: string;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  focus?(): Promise<unknown>;
}

export interface PushSwScope {
  location: Pick<Location, "href" | "origin">;
  registration?: {
    scope?: string;
    showNotification(title: string, options?: PushNotificationOptions): Promise<void>;
  };
  clients: {
    matchAll(options: { type: "window"; includeUncontrolled?: boolean }): Promise<PushClientLike[]>;
    openWindow?(url: string): Promise<unknown>;
  };
}

export interface PushEventDataLike {
  json(): unknown;
}

export interface PushEventLike {
  data?: PushEventDataLike | null;
}

export interface NotificationClickEventLike {
  notification: {
    data?: unknown;
    close(): void;
  };
}

/** Strips control characters (including CSI ANSI / newlines), bidi overrides, and zero-width chars and collapses whitespace to one safe line (L-004). */
export function cleanPushText(value: unknown, maxLen = 80): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/** Validates an external bot id before embedding it in a URL query or notification tag (L-006). */
export function safeBotId(value: unknown): string | null {
  return typeof value === "string" && SAFE_BOT_ID.test(value) ? value : null;
}

/** Formats a push payload into lock-screen notification parameters (bot name + "needs you", never message text). */
export function formatPushNotification(rawPayload: unknown, scopeUrl: string): FormattedPushNotification {
  let payload: Record<string, unknown> = {};
  if (typeof rawPayload === "string") {
    try {
      const parsed = JSON.parse(rawPayload) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
  } else if (rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)) {
    payload = rawPayload as Record<string, unknown>;
  }

  const botName = cleanPushText(payload.botName ?? payload.bot);
  const botId = safeBotId(payload.botId);
  const title = botName || DEFAULT_PUSH_TITLE;
  const body = botName ? NEEDS_YOU_BODY : FALLBACK_NEEDS_YOU_BODY;
  const icon = new URL("./icon-192.png", scopeUrl).href;
  const url = new URL(botId ? `./?bot=${encodeURIComponent(botId)}` : "./", scopeUrl).href;
  const tag = botId ? `botling-needs-${botId}` : "botling-needs";

  return {
    title,
    options: {
      body,
      icon,
      tag,
      data: { url, ...(botId ? { botId } : {}) },
    },
  };
}

/** Resolves a notification click destination strictly within the `/v3/` scope (never trusts arbitrary `data.url`). */
export function resolveNotificationUrl(data: unknown, scopeUrl: string): string {
  const botId = data && typeof data === "object" ? safeBotId((data as { botId?: unknown }).botId) : null;
  return new URL(botId ? `./?bot=${encodeURIComponent(botId)}` : "./", scopeUrl).href;
}

export async function handlePush(sw: PushSwScope, event: PushEventLike): Promise<void> {
  if (!sw.registration?.showNotification) return;
  let raw: unknown = null;
  try {
    raw = event.data ? event.data.json() : null;
  } catch {
    raw = null;
  }
  const scopeUrl = sw.registration.scope || sw.location.href;
  const { title, options } = formatPushNotification(raw, scopeUrl);
  await sw.registration.showNotification(title, options);
}

export async function handleNotificationClick(sw: PushSwScope, event: NotificationClickEventLike): Promise<void> {
  event.notification.close();
  const scopeUrl = sw.registration?.scope || sw.location.href;
  const scope = new URL(scopeUrl);
  const targetUrl = resolveNotificationUrl(event.notification.data, scopeUrl);
  const botId = event.notification.data && typeof event.notification.data === "object"
    ? safeBotId((event.notification.data as { botId?: unknown }).botId)
    : null;

  const clients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = clients.find((client) => {
    try {
      const parsed = new URL(client.url);
      return parsed.origin === scope.origin && parsed.pathname.startsWith(scope.pathname);
    } catch {
      return false;
    }
  });

  if (existing) {
    if (typeof existing.focus === "function") await existing.focus().catch(() => undefined);
    if (botId) {
      try { existing.postMessage({ botling3: "push.open", botId }); } catch { /* window closed */ }
    }
    return;
  }

  if (typeof sw.clients.openWindow === "function") {
    await sw.clients.openWindow(targetUrl);
  }
}
