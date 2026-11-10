// The in-app browser for bots (phase 2, 2026-11-10): what main keeps of each pane tab's network traffic (always on, no
// panel), and the four app tools a bot reads the user's pane with: app_browser_tabs, app_browser_open,
// app_browser_requests and app_browser_extract. Kept free of Electron and Node so main, the core and the tests share it.
//
// Main fills one NetCapture per tab from the page's DevTools protocol (Network.*): a ring of the latest requests,
// bounded in count and bytes. Cookie, Set-Cookie and Authorization headers are masked when handed to a bot unless the
// call asks for them. A bot only reads its own pane's tabs and may open a page in its pane; it never clicks, types or
// submits anything (the extraction script runs in an isolated world with those turned off, and the page may not
// navigate while it runs).

/** One request as a bot reads it. */
export interface CapturedRequest {
  id: string;
  url: string;
  method: string;
  /** The DevTools resource type: Document, XHR, Fetch, Script, Image, Stylesheet, Font, Media, WebSocket, Other… */
  type: string;
  started: number;
  status?: number;
  statusText?: string;
  mimeType?: string;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  /** Bytes received (encoded), once it finished. */
  size?: number;
  finished?: boolean;
  failed?: string;
  /** The response body, when it was kept (text up to BODY_KEEP chars; base64 for binary). */
  body?: string;
  bodyBase64?: boolean;
  bodyTruncated?: boolean;
}

export const CAPTURE_MAX_REQUESTS = 500;
export const CAPTURE_MAX_BYTES = 12_000_000;
/** At most this much of one body is kept. */
export const BODY_KEEP = 256_000;
const POST_KEEP = 16_000;
const HEADER_KEEP = 4_000;

/** Headers a bot gets as "<masked>" unless it asks for them (`unmasked_headers`). */
export const SECRET_HEADERS = new Set(["cookie", "set-cookie", "authorization", "proxy-authorization"]);
export const MASKED = "<masked>";

export function maskHeaders(headers: Record<string, string> | undefined, unmasked = false): Record<string, string> | undefined {
  if (!headers || unmasked) return headers;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name] = SECRET_HEADERS.has(name.toLowerCase()) ? MASKED : value;
  return out;
}

function headerMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number") out[name] = String(value).slice(0, HEADER_KEEP);
  }
  return out;
}

const sizeOf = (entry: CapturedRequest) => {
  let bytes = 200 + entry.url.length + (entry.postData?.length ?? 0) + (entry.body?.length ?? 0);
  for (const map of [entry.requestHeaders, entry.responseHeaders]) if (map) for (const [k, v] of Object.entries(map)) bytes += k.length + v.length;
  return bytes;
};

/** Text-like responses whose body main keeps as soon as it finishes (others are fetched when a bot asks). */
export function keepsBody(type: string, mimeType: string | undefined, size: number | undefined): boolean {
  if (size !== undefined && size > BODY_KEEP * 4) return false;
  if (type !== "XHR" && type !== "Fetch" && type !== "Document") return false;
  return !mimeType || /json|text|xml|javascript|html|csv|graphql/i.test(mimeType);
}

/** One tab's traffic: the latest requests, at most `maxRequests` and about `maxBytes` (the oldest go first). */
export class NetCapture {
  private readonly entries = new Map<string, CapturedRequest>();
  private bytes = 0;
  constructor(private readonly maxRequests = CAPTURE_MAX_REQUESTS, private readonly maxBytes = CAPTURE_MAX_BYTES) {}

  /** A DevTools protocol event; returns the request id when its body should be fetched now (`keepsBody`). */
  handle(method: string, params: unknown): string | null {
    const p = (params && typeof params === "object" ? params : {}) as Record<string, any>;
    const id = typeof p.requestId === "string" ? p.requestId : null;
    if (!id) return null;
    switch (method) {
      case "Network.requestWillBeSent": {
        const request = p.request ?? {};
        if (typeof request.url !== "string" || request.url.startsWith("data:")) return null;
        // A redirect reuses the id: the earlier hop stays under its own key.
        const old = this.entries.get(id);
        if (old && p.redirectResponse) this.rekey(id, `${id}:${old.started}`);
        this.put({
          id, url: request.url.slice(0, 8_000), method: String(request.method ?? "GET"), type: String(p.type ?? "Other"),
          started: typeof p.wallTime === "number" ? Math.round(p.wallTime * 1000) : Date.now(),
          requestHeaders: headerMap(request.headers),
          ...(typeof request.postData === "string" ? { postData: request.postData.slice(0, POST_KEEP) } : {}),
        });
        return null;
      }
      case "Network.requestWillBeSentExtraInfo":
        // The headers as sent (cookies included), which requestWillBeSent leaves out.
        this.change(id, (entry) => { entry.requestHeaders = { ...entry.requestHeaders, ...headerMap(p.headers) }; });
        return null;
      case "Network.responseReceived": {
        const response = p.response ?? {};
        this.change(id, (entry) => {
          entry.status = typeof response.status === "number" ? response.status : undefined;
          if (typeof response.statusText === "string" && response.statusText) entry.statusText = response.statusText.slice(0, 200);
          if (typeof response.mimeType === "string") entry.mimeType = response.mimeType;
          entry.responseHeaders = { ...(entry.responseHeaders ?? {}), ...headerMap(response.headers) };
          if (typeof p.type === "string") entry.type = p.type;
        });
        return null;
      }
      case "Network.responseReceivedExtraInfo":
        this.change(id, (entry) => { entry.responseHeaders = { ...(entry.responseHeaders ?? {}), ...headerMap(p.headers) }; });
        return null;
      case "Network.loadingFinished": {
        const entry = this.entries.get(id);
        if (!entry) return null;
        this.change(id, (each) => { each.finished = true; if (typeof p.encodedDataLength === "number") each.size = p.encodedDataLength; });
        return keepsBody(entry.type, entry.mimeType, entry.size) ? id : null;
      }
      case "Network.loadingFailed":
        this.change(id, (entry) => { entry.finished = true; entry.failed = String(p.errorText ?? "failed").slice(0, 200); });
        return null;
      default: return null;
    }
  }

  /** A body main fetched (Network.getResponseBody), cut to BODY_KEEP. */
  setBody(id: string, body: string, base64: boolean): void {
    this.change(id, (entry) => {
      entry.bodyTruncated = body.length > BODY_KEEP;
      entry.body = body.slice(0, BODY_KEEP);
      entry.bodyBase64 = base64;
    });
  }

  get(id: string): CapturedRequest | undefined { return this.entries.get(id); }
  /** Oldest first. */
  all(): CapturedRequest[] { return [...this.entries.values()]; }
  get size(): number { return this.entries.size; }
  get byteSize(): number { return this.bytes; }
  clear(): void { this.entries.clear(); this.bytes = 0; }

  private put(entry: CapturedRequest) {
    const old = this.entries.get(entry.id);
    if (old) { this.bytes -= sizeOf(old); this.entries.delete(entry.id); }
    this.entries.set(entry.id, entry);
    this.bytes += sizeOf(entry);
    this.trim();
  }
  private change(id: string, edit: (entry: CapturedRequest) => void) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.bytes -= sizeOf(entry);
    edit(entry);
    this.bytes += sizeOf(entry);
    this.trim();
  }
  private rekey(from: string, to: string) {
    const entry = this.entries.get(from);
    if (!entry) return;
    this.entries.delete(from);
    entry.id = to;
    this.entries.set(to, entry);
  }
  private trim() {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.maxRequests && this.bytes <= this.maxBytes) break;
      // The newest entry always stays, even alone over the byte cap.
      if (this.entries.size === 1) break;
      this.entries.delete(id);
      this.bytes -= sizeOf(entry);
    }
  }
}

export interface RequestFilter {
  urlContains?: string;
  /** A resource type (case does not matter); "xhr" also matches Fetch, as DevTools' Fetch/XHR filter does. */
  type?: string;
  method?: string;
  /** The newest this many (default 50, at most 200). */
  limit?: number;
}

/** The requests that match, newest last. */
export function filterRequests(entries: readonly CapturedRequest[], filter: RequestFilter): CapturedRequest[] {
  const needle = filter.urlContains?.toLowerCase();
  const type = filter.type?.toLowerCase();
  const method = filter.method?.toUpperCase();
  const matched = entries.filter((entry) => {
    if (needle && !entry.url.toLowerCase().includes(needle)) return false;
    if (type) {
      const own = entry.type.toLowerCase();
      if (own !== type && !((type === "xhr" || type === "fetch") && (own === "xhr" || own === "fetch"))) return false;
    }
    if (method && entry.method.toUpperCase() !== method) return false;
    return true;
  });
  const limit = Math.min(200, Math.max(1, Math.floor(filter.limit ?? 50)));
  return matched.slice(-limit);
}

// ---- The bot tools ----

export const BROWSER_TOOLS = ["app_browser_tabs", "app_browser_open", "app_browser_requests", "app_browser_extract"] as const;
export type BrowserToolName = (typeof BROWSER_TOOLS)[number];
export const isBrowserTool = (name: string): name is BrowserToolName => (BROWSER_TOOLS as readonly string[]).includes(name);

export type ExtractWhat = "tables" | "text" | "links" | "selector" | "script";
export type SaveAs = "json" | "csv" | "txt";

/** What the core asks main for (the `browser` app op), checked on both sides. */
export type BrowserBotRequest =
  | { op: "tabs"; botId: string }
  | { op: "open"; botId: string; url: string }
  | { op: "requests"; botId: string; tabId?: string; filter: RequestFilter; bodies: boolean; unmasked: boolean }
  | { op: "extract"; botId: string; tabId?: string; what: ExtractWhat; selector?: string; script?: string };

export const SCRIPT_MAX = 20_000;
const BOT_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const TAB_ID = /^t[0-9]{1,12}$/;
const WHATS: readonly ExtractWhat[] = ["tables", "text", "links", "selector", "script"];

function optionalString(args: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  if (value.length > max) throw new Error(`${key} is too long (at most ${max} characters).`);
  return value;
}
function optionalBool(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new Error(`${key} must be true or false.`);
  return value;
}

/** A bot's tool call as the request main takes; an error says what is wrong (nothing was done). */
export function browserRequest(botId: string, name: BrowserToolName, args: Record<string, unknown>): BrowserBotRequest {
  if (!BOT_ID.test(botId)) throw new Error("No bot.");
  const tabId = optionalString(args, "tab_id", 20);
  if (tabId !== undefined && !TAB_ID.test(tabId)) throw new Error("tab_id is not a tab of the pane (see app_browser_tabs).");
  switch (name) {
    case "app_browser_tabs": return { op: "tabs", botId };
    case "app_browser_open": {
      const url = optionalString(args, "url", 8_000);
      if (!url || !isHttpUrl(url)) throw new Error("url must be an http(s) address.");
      return { op: "open", botId, url };
    }
    case "app_browser_requests": {
      const limit = args.limit;
      if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) throw new Error("limit must be a positive integer.");
      const filter: RequestFilter = {};
      const urlContains = optionalString(args, "url_contains", 2_000);
      const type = optionalString(args, "resource_type", 40);
      const method = optionalString(args, "method", 20);
      if (urlContains) filter.urlContains = urlContains;
      if (type) filter.type = type;
      if (method) filter.method = method;
      if (typeof limit === "number") filter.limit = limit;
      return { op: "requests", botId, ...(tabId ? { tabId } : {}), filter, bodies: optionalBool(args, "include_bodies"), unmasked: optionalBool(args, "unmasked_headers") };
    }
    case "app_browser_extract": {
      const what = (optionalString(args, "what", 20) ?? (args.script ? "script" : args.selector ? "selector" : "tables")) as ExtractWhat;
      if (!WHATS.includes(what)) throw new Error(`what must be one of ${WHATS.join(", ")}.`);
      const selector = optionalString(args, "selector", 2_000);
      const script = optionalString(args, "script", SCRIPT_MAX);
      if (what === "selector" && !selector) throw new Error("what \"selector\" needs a selector.");
      if (what === "script" && !script) throw new Error("what \"script\" needs a script.");
      return { op: "extract", botId, ...(tabId ? { tabId } : {}), what, ...(selector ? { selector } : {}), ...(what === "script" && script ? { script } : {}) };
    }
  }
}

/** The same request, checked again where main takes it (null: refused). */
export function parseBrowserBotRequest(raw: unknown): BrowserBotRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.botId !== "string") return null;
  const names: Record<string, BrowserToolName> = { tabs: "app_browser_tabs", open: "app_browser_open", requests: "app_browser_requests", extract: "app_browser_extract" };
  const name = typeof r.op === "string" ? names[r.op] : undefined;
  if (!name) return null;
  const filter = (r.filter && typeof r.filter === "object" ? r.filter : {}) as Record<string, unknown>;
  try {
    return browserRequest(r.botId, name, {
      url: r.url, tab_id: r.tabId, what: r.what, selector: r.selector, script: r.script,
      url_contains: filter.urlContains, resource_type: filter.type, method: filter.method, limit: filter.limit,
      include_bodies: r.bodies, unmasked_headers: r.unmasked,
    });
  } catch { return null; }
}

export function isHttpUrl(url: string): boolean {
  try { const u = new URL(url); return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname; } catch { return false; }
}

/** A request as it goes to a bot: secret headers masked, a long body cut to `bodyMax`. */
export function forBot(entry: CapturedRequest, { bodies, unmasked, bodyMax }: { bodies: boolean; unmasked: boolean; bodyMax: number }): CapturedRequest {
  const { body, bodyBase64, bodyTruncated, ...rest } = entry;
  const out: CapturedRequest = { ...rest, requestHeaders: maskHeaders(entry.requestHeaders, unmasked)! };
  if (entry.responseHeaders) out.responseHeaders = maskHeaders(entry.responseHeaders, unmasked);
  if (bodies && body !== undefined) {
    out.body = body.slice(0, bodyMax);
    if (bodyBase64) out.bodyBase64 = true;
    if (bodyTruncated || body.length > bodyMax) out.bodyTruncated = true;
  }
  return out;
}

// ---- Data a bot saves ----

/** Rows as CSV (RFC 4180): an array of arrays, or of objects (their keys, in first-seen order, make the header). */
export function toCsv(rows: readonly unknown[]): string {
  const cell = (value: unknown) => {
    const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
  };
  if (rows.every((row) => Array.isArray(row))) return rows.map((row) => (row as unknown[]).map(cell).join(",")).join("\r\n") + "\r\n";
  const keys: string[] = [];
  for (const row of rows) if (row && typeof row === "object") for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
  const lines = [keys.map(cell).join(",")];
  for (const row of rows) lines.push(keys.map((key) => cell(row && typeof row === "object" ? (row as Record<string, unknown>)[key] : undefined)).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** The rows a CSV is made of: the data itself when it is a list, else the first table's (header + rows) of a `tables` result. */
export function csvRows(data: unknown): unknown[] | null {
  if (Array.isArray(data) && data.every((row) => Array.isArray(row) || (row && typeof row === "object"))) {
    const tables = data as { headers?: unknown; rows?: unknown }[];
    if (tables.length && tables.every((t) => t && typeof t === "object" && !Array.isArray(t) && Array.isArray(t.rows))) {
      const first = tables[0]!;
      return [...(Array.isArray(first.headers) && first.headers.length ? [first.headers] : []), ...(first.rows as unknown[])];
    }
    return data;
  }
  return null;
}
