// Everything the relay reads from its environment. No config file, no secrets: the relay holds no key and
// stores nothing, so a pod can be killed and replaced at any time (desktops and phones reconnect).
export interface RelayConfig {
  /** Listen port (plain HTTP/WS; TLS ends at the ingress). */
  port: number;
  host: string;
  /** Browser origins allowed to open the WebSocket. Empty: only the relay's own origin (Origin host == Host). A client
   * without an Origin header (the desktop app) is always allowed: Origin is a browser control, not authentication. */
  allowedOrigins: string[];
  /** Optional folder with the phone web app (desktop/mobile/dist), served under /mobile/. */
  staticDir: string | null;
  /** Public https origin, used in the chat page's CSP. Default: https://<Host header>. */
  publicOrigin: string | null;
  /** Largest frame either side may send (bytes). A chat snapshot is the biggest thing that travels. */
  maxFrameBytes: number;
  maxConnections: number;
  maxRooms: number;
  maxPeersPerRoom: number;
  /** New WebSocket connections per client address per minute. */
  connectsPerMinute: number;
  /** Refused joins (bad token, no desktop) per client address per minute before further joins are refused outright. */
  failedJoinsPerMinute: number;
  /** Messages per connection: sustained per second, and burst. */
  messagesPerSecond: number;
  messageBurst: number;
  /** Seconds a new connection has to say who it is. */
  helloTimeoutSeconds: number;
  /** Trust the first X-Forwarded-For address (set it behind an ingress so limits apply per phone, not per ingress pod). */
  trustProxy: boolean;
}

const int = (env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (url.origin !== origin) throw new Error(`ALLOWED_ORIGINS entries must be bare origins (got ${origin}).`);
  }
  const publicOrigin = env.PUBLIC_ORIGIN?.trim() || null;
  if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin) throw new Error('PUBLIC_ORIGIN must be a bare origin.');
  return {
    port: int(env, 'PORT', 8080, 0, 65535),
    host: env.HOST?.trim() || '0.0.0.0',
    allowedOrigins,
    staticDir: env.STATIC_DIR?.trim() || null,
    publicOrigin,
    maxFrameBytes: int(env, 'MAX_FRAME_BYTES', 4 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    maxConnections: int(env, 'MAX_CONNECTIONS', 5_000),
    maxRooms: int(env, 'MAX_ROOMS', 5_000),
    maxPeersPerRoom: int(env, 'MAX_PEERS_PER_ROOM', 16, 1, 1_000),
    connectsPerMinute: int(env, 'CONNECTS_PER_MINUTE', 60),
    failedJoinsPerMinute: int(env, 'FAILED_JOINS_PER_MINUTE', 10),
    messagesPerSecond: int(env, 'MESSAGES_PER_SECOND', 50),
    messageBurst: int(env, 'MESSAGE_BURST', 200),
    helloTimeoutSeconds: int(env, 'HELLO_TIMEOUT_SECONDS', 10, 1, 300),
    trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY ?? ''),
  };
}
