// Web Push sender (protocol v1 §18.4, M4-23).
// - Sends only for bots this server owns (`ownsBot`).
// - Reads the cluster VAPID key pair from `vapid-keys.json` (`readVapidKeys`) and never logs private keys or
//   subscription secrets (`auth`, `p256dh`, endpoint capability path).
// - Sends only to valid, unrevoked devices returned by the roster (`roster.pushSubscriptions()`).
// - Encrypts payloads containing only bot identity (`botId`, `botName`, `kind: "needs-you"`), never message text.
import type { PushSubscription } from "../../protocol";
import { readVapidKeys } from "../identity/vapid";
import { encryptPushPayload } from "./encrypt";
import { createPushTransport, type PushTransport } from "./transport";
import { DEFAULT_VAPID_EXP_SECONDS, DEFAULT_VAPID_SUBJECT, vapidAuthorizationHeader } from "./vapid-jwt";

export const DEFAULT_PUSH_TTL_SECONDS = 3600;
export const DEFAULT_PUSH_TIMEOUT_MS = 10_000;

export interface PushRoster {
  pushSubscriptions(): Array<{ device: string; subscription: PushSubscription }>;
}

export interface PushSenderOptions {
  dataDir: string;
  ownsBot: (botId: string) => boolean;
  roster: PushRoster;
  subject?: string;
  ttlSeconds?: number;
  jwtTtlSeconds?: number;
  timeoutMs?: number;
  now?: () => number;
  transport?: PushTransport;
  log?: (line: string) => void;
}

export interface PushAlert {
  botId: string;
  botName: string;
  /** Optional target device allowlist; still filtered against valid unrevoked roster subscriptions. */
  devices?: readonly string[];
  /** Optional devices to exclude (e.g. devices currently attached). */
  excludeDevices?: ReadonlySet<string> | readonly string[];
}

export interface PushNotificationPayload {
  v: 1;
  kind: "needs-you";
  botId: string;
  botName: string;
}

export type PushDeviceResult =
  | { device: string; ok: true; status: number }
  | { device: string; ok: false; status?: number; gone?: boolean; retryable?: boolean; reason: string };

export interface PushSendReport {
  sent: number;
  skipped?: "not-owned" | "no-vapid-keys" | "no-subscriptions";
  results: PushDeviceResult[];
}

function safeOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return "<invalid-endpoint>";
  }
}

export class PushSender {
  private readonly transport: PushTransport;
  private readonly ttlSeconds: number;
  private readonly jwtTtlSeconds: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: PushSenderOptions) {
    this.transport = options.transport ?? createPushTransport();
    const ttl = options.ttlSeconds ?? DEFAULT_PUSH_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl < 0) throw new RangeError("push: ttlSeconds must be a non-negative integer");
    this.ttlSeconds = ttl;
    this.jwtTtlSeconds = options.jwtTtlSeconds ?? DEFAULT_VAPID_EXP_SECONDS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS;
  }

  async notify(alert: PushAlert): Promise<PushSendReport> {
    if (!this.options.ownsBot(alert.botId)) {
      return { sent: 0, skipped: "not-owned", results: [] };
    }

    const keys = readVapidKeys(this.options.dataDir);
    if (!keys) {
      return { sent: 0, skipped: "no-vapid-keys", results: [] };
    }

    const allow = alert.devices ? new Set(alert.devices) : null;
    const exclude = alert.excludeDevices
      ? (alert.excludeDevices instanceof Set ? alert.excludeDevices : new Set(alert.excludeDevices))
      : null;

    const targets = this.options.roster.pushSubscriptions().filter(({ device }) => {
      if (allow && !allow.has(device)) return false;
      if (exclude && exclude.has(device)) return false;
      return true;
    });

    if (!targets.length) {
      return { sent: 0, skipped: "no-subscriptions", results: [] };
    }

    const botName = alert.botName.trim().slice(0, 100) || "Bot";
    const payload: PushNotificationPayload = {
      v: 1,
      kind: "needs-you",
      botId: alert.botId,
      botName,
    };
    const plaintext = JSON.stringify(payload);
    const subject = this.options.subject ?? DEFAULT_VAPID_SUBJECT;

    const results = await Promise.all(targets.map(async ({ device, subscription }): Promise<PushDeviceResult> => {
      const origin = safeOrigin(subscription.endpoint);
      try {
        const encrypted = encryptPushPayload({
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          plaintext,
        });
        const authHeader = vapidAuthorizationHeader({
          keys,
          endpoint: subscription.endpoint,
          subject,
          ttlSeconds: this.jwtTtlSeconds,
          now: this.options.now,
        });
        const response = await this.transport({
          url: subscription.endpoint,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Encoding": encrypted.contentEncoding,
            "Content-Length": String(encrypted.body.byteLength),
            TTL: String(this.ttlSeconds),
            Authorization: authHeader,
          },
          body: encrypted.body,
          timeoutMs: this.timeoutMs,
        });

        const status = response.status;
        if (status >= 200 && status < 300) {
          return { device, ok: true, status };
        }
        const gone = status === 404 || status === 410;
        const retryable = status === 429 || status >= 500;
        this.options.log?.(`push: delivery to ${device} (${origin}) failed with HTTP ${status}`);
        return { device, ok: false, status, ...(gone ? { gone: true } : {}), ...(retryable ? { retryable: true } : {}), reason: `http-${status}` };
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const safeMessage = rawMessage.split(subscription.endpoint).join(origin);
        this.options.log?.(`push: delivery to ${device} (${origin}) failed: ${safeMessage}`);
        return { device, ok: false, retryable: true, reason: safeMessage };
      }
    }));

    const sent = results.filter((r) => r.ok).length;
    return { sent, results };
  }
}
