// Browser-side Web Push opt-in and subscription sync (M4-25, protocol v1 §18.4, M4-22-review R4 & N2).
//
// - Never subscribes or registers the service worker on load: only after the user explicitly clicks the button in
//   "This device", or re-syncs an already opted-in browser on attach (e.g. when `welcome.vapidPublicKey` rotates after
//   a server revocation).
// - iOS Safari tabs outside the Home Screen app cannot receive Web Push: `pushSupport` detects this and surfaces
//   explicit guidance.
// - Never logs or surfaces `endpoint`, `keys.p256dh`, or `keys.auth` (L-015).
import { fromBase64Url, PushSubscription as PushSubscriptionSchema, toBase64Url, type PushSubscription as WirePushSubscription } from "../../src/protocol";

export const PUSH_ENABLED_PREF = "pushEnabled";
export const PUSH_VAPID_PREF = "pushVapidKey";
export const PUSH_VAPID_HISTORY_PREF = "pushVapidKeys";
const MAX_VAPID_HISTORY = 16;

function parseVapidHistory(raw: string | null, storedKey: string | null): string[] {
  const keys: string[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string" && item.length > 0 && !keys.includes(item)) keys.push(item);
        }
      }
    } catch {
      // Ignore corrupt pref; re-seed from storedKey below if present.
    }
  }
  if (storedKey && !keys.includes(storedKey)) keys.push(storedKey);
  return keys.slice(-MAX_VAPID_HISTORY);
}

function appendVapidHistory(history: readonly string[], key: string): string[] {
  const next = history.filter((item) => item !== key);
  next.push(key);
  return next.slice(-MAX_VAPID_HISTORY);
}

export interface PushPrefs {
  load(name: string): Promise<string | null>;
  save(name: string, value: string): Promise<void>;
}

export type PushSupportState =
  | { supported: true }
  | { supported: false; reason: "ios-home-screen" | "unsupported" | "denied"; message: string };

export interface PushEnvironment {
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean;
  matchMediaStandalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  notificationPermission: NotificationPermission | undefined;
}

export function readPushEnvironment(): PushEnvironment {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const win = typeof window !== "undefined" ? window : undefined;
  return {
    userAgent: nav?.userAgent ?? "",
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    standalone: (nav as { standalone?: boolean } | undefined)?.standalone === true,
    matchMediaStandalone: win?.matchMedia?.("(display-mode: standalone)")?.matches === true,
    hasServiceWorker: !!nav?.serviceWorker,
    hasPushManager: typeof globalThis !== "undefined" && "PushManager" in globalThis,
    notificationPermission: typeof Notification !== "undefined" ? Notification.permission : undefined,
  };
}

export function isIosBrowser(env: Pick<PushEnvironment, "userAgent" | "maxTouchPoints">): boolean {
  return /iPhone|iPad|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
}

export function isStandaloneApp(env: Pick<PushEnvironment, "standalone" | "matchMediaStandalone">): boolean {
  return env.standalone || env.matchMediaStandalone;
}

export function pushSupport(env: PushEnvironment = readPushEnvironment()): PushSupportState {
  if (isIosBrowser(env) && !isStandaloneApp(env)) {
    return {
      supported: false,
      reason: "ios-home-screen",
      message: "Add this app to your Home Screen to enable notifications on iPhone or iPad.",
    };
  }
  if (!env.hasServiceWorker || !env.hasPushManager || env.notificationPermission === undefined) {
    return {
      supported: false,
      reason: "unsupported",
      message: "Push notifications are not supported in this browser.",
    };
  }
  if (env.notificationPermission === "denied") {
    return {
      supported: false,
      reason: "denied",
      message: "Notifications are blocked in browser settings for this site.",
    };
  }
  return { supported: true };
}

/** Decodes an 87-char base64url VAPID public key into a 65-byte uncompressed P-256 buffer for PushManager. */
export function decodeApplicationServerKey(vapidPublicKey: string): Uint8Array<ArrayBuffer> | null {
  const raw = fromBase64Url(vapidPublicKey);
  if (!raw || raw.length !== 65 || raw[0] !== 4) return null;
  const copy = new Uint8Array(new ArrayBuffer(65));
  copy.set(raw);
  return copy;
}

/** Extracts and validates `{ endpoint, keys: { p256dh, auth } }` from a browser PushSubscription. */
export function extractPushSubscription(subscription: PushSubscription | null | undefined): WirePushSubscription | null {
  if (!subscription) return null;
  const endpoint = subscription.endpoint;
  let p256dh: string | undefined;
  let auth: string | undefined;
  try {
    const p256dhBuf = subscription.getKey?.("p256dh");
    const authBuf = subscription.getKey?.("auth");
    if (p256dhBuf) p256dh = toBase64Url(new Uint8Array(p256dhBuf));
    if (authBuf) auth = toBase64Url(new Uint8Array(authBuf));
  } catch {
    // Fall back to toJSON below.
  }
  if (!p256dh || !auth) {
    try {
      const json = subscription.toJSON?.();
      p256dh = p256dh ?? json?.keys?.p256dh;
      auth = auth ?? json?.keys?.auth;
    } catch {
      return null;
    }
  }
  if (!endpoint || !p256dh || !auth) return null;
  const parsed = PushSubscriptionSchema.safeParse({ endpoint, keys: { p256dh, auth } });
  return parsed.success ? parsed.data : null;
}

function subscriptionMatchesKey(subscription: PushSubscription, vapidPublicKey: string, storedKey: string | null): boolean {
  const existing = subscription.options?.applicationServerKey as BufferSource | null | undefined;
  if (existing instanceof ArrayBuffer) {
    return toBase64Url(new Uint8Array(existing)) === vapidPublicKey;
  }
  if (existing && ArrayBuffer.isView(existing)) {
    return toBase64Url(new Uint8Array(existing.buffer, existing.byteOffset, existing.byteLength)) === vapidPublicKey;
  }
  return storedKey === vapidPublicKey;
}

export interface EnablePushOptions {
  vapidPublicKey: string | null;
  sendPushSubscribe(sub: WirePushSubscription): boolean;
  prefs: PushPrefs;
  requestPermission?: () => Promise<NotificationPermission>;
  registerSw?: () => Promise<ServiceWorkerRegistration>;
}

export type EnablePushResult =
  | { ok: true; sent: boolean }
  | { ok: false; message: string };

/** Explicit user opt-in: asks permission, registers `./sw.js` if needed, subscribes with VAPID key, and sends live. */
export async function enablePushNotifications(options: EnablePushOptions): Promise<EnablePushResult> {
  if (!options.vapidPublicKey) {
    return { ok: false, message: "Connect to your server to enable notifications." };
  }
  const appServerKey = decodeApplicationServerKey(options.vapidPublicKey);
  if (!appServerKey) {
    return { ok: false, message: "The server's notification key is invalid." };
  }
  const askPermission = options.requestPermission ?? (() => Notification.requestPermission());
  const permission = await askPermission();
  if (permission !== "granted") {
    return { ok: false, message: permission === "denied" ? "Notifications are blocked in browser settings." : "Notification permission was not granted." };
  }
  const register = options.registerSw ?? (async () => {
    const reg = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    return navigator.serviceWorker.ready.catch(() => reg);
  });
  const registration = await register();
  if (!registration?.pushManager) {
    return { ok: false, message: "Push notifications are unavailable in this browser." };
  }
  const storedKey = await options.prefs.load(PUSH_VAPID_PREF).catch(() => null);
  let sub = await registration.pushManager.getSubscription();
  if (sub && !subscriptionMatchesKey(sub, options.vapidPublicKey, storedKey)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  if (!sub) {
    sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey });
  }
  const wire = extractPushSubscription(sub);
  if (!wire) {
    return { ok: false, message: "This browser returned a push subscription that could not be verified." };
  }
  const sent = options.sendPushSubscribe(wire);
  await options.prefs.save(PUSH_ENABLED_PREF, "1").catch(() => undefined);
  await options.prefs.save(PUSH_VAPID_PREF, options.vapidPublicKey).catch(() => undefined);
  await options.prefs.save(PUSH_VAPID_HISTORY_PREF, JSON.stringify([options.vapidPublicKey])).catch(() => undefined);
  return { ok: true, sent };
}

export interface SyncPushOptions {
  vapidPublicKey: string | null;
  sendPushSubscribe(sub: WirePushSubscription): boolean;
  prefs: PushPrefs;
  permission?: NotificationPermission;
  getRegistration?: () => Promise<ServiceWorkerRegistration | undefined>;
}

/**
 * Re-syncs (and re-subscribes if the cluster VAPID key rotated) on attach ONLY if the user previously opted in.
 * Never registers a service worker or asks permission if the user has not opted in.
 */
export async function syncPushOnAttach(options: SyncPushOptions): Promise<"off" | "missing-key" | "no-registration" | "synced" | "resubscribed" | "key-mismatch" | "invalid"> {
  const permission = options.permission ?? (typeof Notification !== "undefined" ? Notification.permission : "default");
  if (permission !== "granted") return "off";
  const enabled = await options.prefs.load(PUSH_ENABLED_PREF).catch(() => null);
  if (enabled !== "1") return "off";
  if (!options.vapidPublicKey) return "missing-key";
  const appServerKey = decodeApplicationServerKey(options.vapidPublicKey);
  if (!appServerKey) return "invalid";

  const getReg = options.getRegistration ?? (() => navigator.serviceWorker?.getRegistration?.("./") ?? Promise.resolve(undefined));
  const registration = await getReg().catch(() => undefined);
  if (!registration?.pushManager) return "no-registration";

  const storedKey = await options.prefs.load(PUSH_VAPID_PREF).catch(() => null);
  const history = parseVapidHistory(
    await options.prefs.load(PUSH_VAPID_HISTORY_PREF).catch(() => null),
    storedKey,
  );
  let sub = await registration.pushManager.getSubscription().catch(() => null);
  let resubscribed = false;
  if (sub && !subscriptionMatchesKey(sub, options.vapidPublicKey, storedKey)) {
    if (history.includes(options.vapidPublicKey)) return "key-mismatch";
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  if (!sub) {
    sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey });
    resubscribed = true;
  }
  const wire = extractPushSubscription(sub);
  if (!wire) return "invalid";
  const sent = options.sendPushSubscribe(wire);
  if (!sent) return "invalid";
  await options.prefs.save(PUSH_VAPID_PREF, options.vapidPublicKey).catch(() => undefined);
  await options.prefs.save(
    PUSH_VAPID_HISTORY_PREF,
    JSON.stringify(appendVapidHistory(history, options.vapidPublicKey)),
  ).catch(() => undefined);
  return resubscribed ? "resubscribed" : "synced";
}

export async function disablePushNotifications(
  prefs: PushPrefs,
  getRegistration: () => Promise<ServiceWorkerRegistration | undefined> = () => navigator.serviceWorker?.getRegistration?.("./") ?? Promise.resolve(undefined),
): Promise<void> {
  await prefs.save(PUSH_ENABLED_PREF, "0").catch(() => undefined);
  await prefs.save(PUSH_VAPID_PREF, "").catch(() => undefined);
  await prefs.save(PUSH_VAPID_HISTORY_PREF, "").catch(() => undefined);
  const reg = await getRegistration().catch(() => undefined);
  const sub = await reg?.pushManager?.getSubscription().catch(() => null);
  if (sub) await sub.unsubscribe().catch(() => false);
}
