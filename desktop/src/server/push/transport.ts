// Send-time SSRF guard and HTTPS push transport (protocol v1 §18.4, M4-22/M4-23).
// - Validates the endpoint URL (`PushEndpoint`: https, default port, public DNS hostname).
// - Resolves DNS ahead of dialing, refuses if ANY returned address is private/loopback/CGNAT/link-local/multicast,
//   and pins the verified public IP into `https.request` (prevents DNS rebinding TOCTOU).
// - Disables HTTP redirects (`https.request` never follows 3xx) and enforces timeouts.
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { PushEndpoint } from "../../protocol";

export interface PushHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
  timeoutMs: number;
}

export interface PushHttpResponse {
  status: number;
  /** Optional `Retry-After` response header value (used for 429/503 backoff). */
  retryAfter?: string;
}

export type PushTransport = (request: PushHttpRequest) => Promise<PushHttpResponse>;

export type DnsLookupFn = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;
export type HttpsRequestFn = (
  url: string | URL,
  options: RequestOptions,
  callback?: (res: IncomingMessage) => void,
) => ClientRequest;

export interface PushTransportOptions {
  lookup?: DnsLookupFn;
  request?: HttpsRequestFn;
}

function isPublicIpv4Bytes(a: number, b: number, c: number, d: number): boolean {
  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // 10.0.0.0/8 RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT / Tailscale
  if (a === 127) return false; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return false; // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12 RFC 1918
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0.0/24 IETF protocol
  if (a === 192 && b === 0 && c === 2) return false; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return false; // 192.168.0.0/16 RFC 1918
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return false; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved / broadcast
  void d;
  return true;
}

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^(0|[1-9][0-9]*)$/.test(p) ? Number(p) : -1));
  if (nums.some((n) => n < 0 || n > 255)) return null;
  return [nums[0], nums[1], nums[2], nums[3]];
}

function parseIpv6Hextets(ip: string): number[] | null {
  const doubleColon = ip.indexOf("::");
  if (doubleColon !== -1 && ip.indexOf("::", doubleColon + 2) !== -1) return null;

  const [leftRaw, rightRaw] = doubleColon === -1 ? [ip, null] : [ip.slice(0, doubleColon), ip.slice(doubleColon + 2)];
  const parseSide = (side: string, allowIpv4Tail: boolean): number[] | null => {
    if (!side) return [];
    const tokens = side.split(":");
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (allowIpv4Tail && i === tokens.length - 1 && tok.includes(".")) {
        const v4 = parseIpv4(tok);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(tok)) return null;
        out.push(Number.parseInt(tok, 16));
      }
    }
    return out;
  };

  const left = parseSide(leftRaw, rightRaw === null);
  if (!left) return null;
  if (rightRaw === null) return left.length === 8 ? left : null;
  const right = parseSide(rightRaw, true);
  if (!right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isPublicIpv6Hextets(h: readonly number[]): boolean {
  // Unspecified ::/128 and loopback ::1/128
  const allZeroPrefix6 = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0;
  if (allZeroPrefix6 && h[6] === 0 && (h[7] === 0 || h[7] === 1)) return false;

  // IPv4-mapped ::ffff:0:0/96 and deprecated IPv4-compatible ::/96
  if (allZeroPrefix6 && (h[6] !== 0 || h[7] !== 0) && h[5] === 0) {
    return isPublicIpv4Bytes(h[6] >>> 8, h[6] & 0xff, h[7] >>> 8, h[7] & 0xff);
  }
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    return isPublicIpv4Bytes(h[6] >>> 8, h[6] & 0xff, h[7] >>> 8, h[7] & 0xff);
  }

  // NAT64 (64:ff9b::/96, 64:ff9b:1::/48)
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) return false;
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0x0001) return false;

  // Discard 100::/64
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return false;
  // Documentation 2001:db8::/32
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false;
  // Teredo 2001::/32 and 6to4 2002::/16 (embed arbitrary IPv4)
  if (h[0] === 0x2001 && h[1] === 0x0000) return false;
  if (h[0] === 0x2002) return false;
  // Benchmarking 2001:2::/48
  if (h[0] === 0x2001 && h[1] === 0x0002 && h[2] === 0) return false;
  // Unique local fc00::/7
  if ((h[0] & 0xfe00) === 0xfc00) return false;
  // Link-local fe80::/10 and deprecated site-local fec0::/10
  if ((h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0) return false;
  // Multicast ff00::/8
  if ((h[0] & 0xff00) === 0xff00) return false;

  return true;
}

/** True only when `rawIp` is a globally routable public IPv4 or IPv6 address (no zone IDs, private, loopback, CGNAT, link-local, or multicast). */
export function isPublicIp(rawIp: string): boolean {
  const ip = rawIp.trim();
  if (!ip || ip.includes("%")) return false;
  const family = isIP(ip);
  if (family === 4) {
    const v4 = parseIpv4(ip);
    return v4 ? isPublicIpv4Bytes(v4[0], v4[1], v4[2], v4[3]) : false;
  }
  if (family === 6) {
    const h = parseIpv6Hextets(ip);
    return h ? isPublicIpv6Hextets(h) : false;
  }
  return false;
}

const defaultLookup: DnsLookupFn = async (hostname) => {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.map((row) => ({ address: row.address, family: row.family }));
};

/**
 * Builds the default Web Push HTTPS transport with send-time SSRF protection:
 * validates the endpoint schema, checks all DNS results are public IPs, pins the chosen IP, and never follows redirects.
 */
export function createPushTransport(options: PushTransportOptions = {}): PushTransport {
  const lookup = options.lookup ?? defaultLookup;
  const requestFn = options.request ?? httpsRequest;

  return async (req) => {
    if (!PushEndpoint.safeParse(req.url).success) {
      throw new Error("push refused: endpoint is not a public https URL");
    }
    const parsed = new URL(req.url);
    const hostname = parsed.hostname.replace(/\.+$/, "");
    // One deadline for the whole send (DNS, connect, TLS, headers): a socket idle timeout alone lets a hostile endpoint
    // trickle bytes forever, and getaddrinfo has no timeout of its own.
    const deadlineAt = Date.now() + req.timeoutMs;
    let dnsTimer: NodeJS.Timeout | undefined;
    const resolved = await Promise.race([
      lookup(hostname),
      new Promise<never>((_, reject) => {
        dnsTimer = setTimeout(() => reject(new Error("push refused: endpoint lookup timed out")), req.timeoutMs);
      }),
    ]).finally(() => clearTimeout(dnsTimer));
    if (!resolved.length) {
      throw new Error("push refused: endpoint hostname resolved to no addresses");
    }
    for (const entry of resolved) {
      if (!isPublicIp(entry.address)) {
        throw new Error("push refused: endpoint resolved to a private or non-public address");
      }
    }
    const chosen = resolved[0];
    const pinnedLookup: NonNullable<RequestOptions["lookup"]> = (_host, opts, cb) => {
      if (typeof opts === "object" && opts !== null && (opts as { all?: boolean }).all) {
        (cb as (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)(null, [
          { address: chosen.address, family: chosen.family },
        ]);
      } else {
        (cb as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
          null,
          chosen.address,
          chosen.family,
        );
      }
    };

    return new Promise<PushHttpResponse>((resolve, reject) => {
      let settled = false;
      let deadline: NodeJS.Timeout | undefined;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        fn();
      };

      const clientReq = requestFn(
        req.url,
        { method: "POST", headers: req.headers, lookup: pinnedLookup },
        (res) => {
          const rawRetryAfter = res.headers?.["retry-after"];
          const retryAfterHeader = Array.isArray(rawRetryAfter) ? rawRetryAfter[0] : rawRetryAfter;
          const retryAfter = typeof retryAfterHeader === "string"
            ? retryAfterHeader.trim().slice(0, 64) || undefined
            : undefined;
          // Only the status (and optional Retry-After header) matters: never read the body, drop the connection.
          done(() => resolve(retryAfter ? { status: res.statusCode ?? 0, retryAfter } : { status: res.statusCode ?? 0 }));
          res.destroy();
        },
      );
      deadline = setTimeout(() => {
        clientReq.destroy(new Error("push request timed out"));
        done(() => reject(new Error("push request timed out")));
      }, Math.max(1, deadlineAt - Date.now()));
      clientReq.setTimeout(req.timeoutMs, () => {
        clientReq.destroy(new Error("push request timed out"));
      });
      clientReq.on("error", (err) => done(() => reject(new Error(`push request failed: ${err.message}`))));
      clientReq.end(req.body);
    });
  };
}
