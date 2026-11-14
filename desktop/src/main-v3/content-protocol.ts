// Botling 3's window reads every file it shows through the server (protocol v1 §9A.4, M1 step 13). No Electron import:
// content-install.ts wires these handlers into Electron's protocols; tests drive them with plain Requests.
//
// - Chat media: the renderer keeps its 2.x URLs, `botling-chat://chat/attachment/<bot>/<file URL>/<name>?line=<id>`.
//   Main asks the server which reference that line holds for the file (`content.find`), opens it with the entry as
//   proof (`content.open` → `content.file` | `content.gone`) and streams the pinned version with the 2.x range code
//   (preview-response.ts). A line's file that the server did not index (no `line`, a step's picture, a file waiting in
//   the input box, an older line) is left to the 2.x handler (null here).
// - `botling-content://c/<owner>/<id>/<variant>?e=<stream>.<seq>`: the §9A.4 URL of a reference (for the pdf.js viewer
//   and later front ends).
// - `botling-content://file/<token>/<name>`: a PDF the user handed to the browser pane (dropped, or a chat link they
//   clicked). The pane's tab loads this instead of `file:` (browser-pdf-v3.ts); main serves the file it granted.
//
// A reference serves the bytes of its hash or nothing (§9A.3): the stat signature from the server is re-checked when the
// file opens, and for a `pin: path` file every 1 MiB chunk streamed is checked against its chunk hash (or, before the
// hash is ready, the signature after each read). A mismatch ends the response with an error, never with other bytes.
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import { attachmentLine, attachmentTarget } from "../contract/attachment-url";
import { CONTENT_CHUNK_BYTES, type MessageOf, type StreamId } from "../protocol";
import { fileHeaders, previewResponse, rangedResponse } from "../main/preview-response";

export const CONTENT_SCHEME = "botling-content";
/** Electron scheme privileges of `botling-content:` (`stream` lets `<video>` seek through a custom protocol). */
export const CONTENT_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, stream: true } as const;
/** The page policy 2.x main gives chat attachments (main.ts `chatFile`). */
export const CHAT_MEDIA_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'";
/** How long main waits for the server's answer before the request fails (the player retries). */
export const ANSWER_TIMEOUT_MS = 10_000;

type ContentFile = MessageOf<"content.file">;
type GoneReason = MessageOf<"content.gone">["reason"];
export type ContentAnswer = MessageOf<"content.found"> | MessageOf<"content.file"> | MessageOf<"content.gone">;

/** What main needs of the server link (src/fe-link FeLink `content`). */
export interface ContentLink {
  content(message: Omit<MessageOf<"content.find">, "req"> | Omit<MessageOf<"content.open">, "req">): Promise<ContentAnswer>;
}

const GONE_TEXT: Record<GoneReason, string> = {
  changed: "This file changed after this message.",
  deleted: "This file is no longer kept.",
  denied: "This file is not part of that message.",
  offline: "The machine that has this file is offline.",
  "too-large": "This file is too large to show.",
};

/** The answer for a reference that cannot be served: 410 (404 for `denied`), never other bytes. */
export function goneResponse(reason: GoneReason): Response {
  return new Response(GONE_TEXT[reason], {
    status: reason === "denied" ? 404 : reason === "offline" ? 503 : 410,
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "X-Botling-Content": `gone; reason=${reason}` },
  });
}

const sameSig = (a: { size: number | bigint; mtimeNs: bigint; ino: bigint }, b: ContentFile["sig"]) =>
  Number(a.size) === b.size && String(a.mtimeNs) === b.mtimeNs && String(a.ino) === b.ino;

async function readFully(handle: FileHandle, buffer: Buffer, position: number): Promise<number> {
  let done = 0;
  while (done < buffer.length) {
    const { bytesRead } = await handle.read(buffer, done, buffer.length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return done;
}

export class ContentChangedError extends Error {
  constructor(readonly at: number) { super(`content changed (at byte ${at})`); this.name = "ContentChangedError"; }
}

/** Bytes start…end (inclusive) of a `pin: path` file, read by whole 1 MiB chunks and each checked before it is sent. */
function verifiedStream(handle: FileHandle, file: ContentFile, start: number, end: number, onChanged?: () => void): ReadableStream<Uint8Array> {
  const hashes = file.chunkHashes ? Buffer.from(file.chunkHashes, "base64") : null;
  const size = file.sig.size;
  let pos = start;
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await handle.close().catch(() => {}); } };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (pos > end) { await close(); controller.close(); return; }
        const index = Math.floor(pos / CONTENT_CHUNK_BYTES);
        const chunkStart = index * CONTENT_CHUNK_BYTES;
        const length = Math.min(CONTENT_CHUNK_BYTES, size - chunkStart);
        const buffer = Buffer.allocUnsafe(length);
        const read = await readFully(handle, buffer, chunkStart);
        if (read !== length) throw new ContentChangedError(chunkStart);
        if (hashes) {
          const expected = hashes.subarray(index * 32, index * 32 + 32);
          if (expected.length !== 32 || !createHash("sha256").update(buffer).digest().equals(expected)) throw new ContentChangedError(chunkStart);
        } else if (!sameSig(await handle.stat({ bigint: true }), file.sig)) {
          throw new ContentChangedError(chunkStart);
        }
        const last = Math.min(end, chunkStart + length - 1);
        controller.enqueue(buffer.subarray(pos - chunkStart, last - chunkStart + 1));
        pos = last + 1;
      } catch (error) {
        await close();
        if (error instanceof ContentChangedError) onChanged?.();
        controller.error(error);
      }
    },
    async cancel() { await close(); },
  }, { highWaterMark: 0 });
}

export interface ServeContentOptions {
  csp?: string;
  /** A chunk of a `pin: path` file did not match: the response ended with an error. */
  onChanged?: () => void;
}

/**
 * Streams the pinned file the server named, with byte ranges answered exactly as preview-response.ts answers them.
 * Clones and copies live in the content store and are never rewritten: after the signature check they go through
 * `previewResponse` itself. A `pin: path` file goes through the same headers and range code with a checked body.
 */
export async function serveContentFile(file: ContentFile, request: Request, options: ServeContentOptions = {}): Promise<Response> {
  if (file.pin !== "path") {
    let now;
    try { now = await stat(file.path, { bigint: true }); } catch { return goneResponse("deleted"); }
    if (!now.isFile() || !sameSig(now, file.sig)) return goneResponse("deleted");
    return previewResponse(file.path, request, { type: file.type, follow: false, csp: options.csp });
  }
  let handle: FileHandle;
  try { handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { options.onChanged?.(); return goneResponse("changed"); }
  let streamed = false;
  try {
    const now = await handle.stat({ bigint: true });
    if (!now.isFile() || !sameSig(now, file.sig)) { options.onChanged?.(); return goneResponse("changed"); }
    const headers = await fileHeaders(handle, file.sig.size, file.type, options.csp);
    return rangedResponse(request, file.sig.size, headers, (start, end) => {
      streamed = true;
      return verifiedStream(handle, file, start, end, options.onChanged);
    });
  } finally {
    if (!streamed) await handle.close();
  }
}

/** The PDFs the user handed to the browser pane, each under an unguessable token (`botling-content://file/…`). */
export class FileGrants {
  private readonly byToken = new Map<string, string>();
  private readonly byPath = new Map<string, string>();

  /** The URL a pane tab loads for `path` (the same path keeps its URL, so its tab is found again). */
  grant(path: string): string {
    let token = this.byPath.get(path);
    if (!token) {
      token = randomBytes(16).toString("hex");
      this.byPath.set(path, token);
      this.byToken.set(token, path);
    }
    return `${CONTENT_SCHEME}://file/${token}/${encodeURIComponent(basename(path) || "file.pdf")}`;
  }

  /** The granted path a `botling-content://file/<token>/…` URL stands for; null for any other URL. */
  path(url: string): string | null {
    const match = /^botling-content:\/\/file\/([0-9a-f]{32})(?:\/[^/?#]*)?$/.exec(url);
    return match ? this.byToken.get(match[1]!) ?? null : null;
  }
}

/** The grants of this window's main process (browser-pdf-v3.ts and content-install.ts share them). */
export const fileGrants = new FileGrants();

/** `botling-content://c/<owner>/<id>/<variant>?e=<stream>.<seq>` → its parts; null when malformed. */
export function parseContentUrl(url: URL): { owner: string; id: string; variant: string; entry: { stream: StreamId; seq: number } } | null {
  if (url.protocol !== `${CONTENT_SCHEME}:` || url.host !== "c") return null;
  const parts = url.pathname.split("/").slice(1).map((part) => { try { return decodeURIComponent(part); } catch { return ""; } });
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  const proof = url.searchParams.get("e") ?? "";
  const dot = proof.lastIndexOf(".");
  const seq = Number(proof.slice(dot + 1));
  if (dot <= 0 || !Number.isSafeInteger(seq) || seq < 1) return null;
  return { owner: parts[0]!, id: parts[1]!, variant: parts[2]!, entry: { stream: proof.slice(0, dot) as StreamId, seq } };
}

/** The §9A.4 URL of a reference. */
export function contentUrl(owner: string, id: string, entry: { stream: string; seq: number }, variant = "original"): string {
  return `${CONTENT_SCHEME}://c/${encodeURIComponent(owner)}/${encodeURIComponent(id)}/${encodeURIComponent(variant)}?e=${encodeURIComponent(`${entry.stream}.${entry.seq}`)}`;
}

export interface ContentProtocolOptions {
  /** The server link now; null while there is none (the 2.x handler then answers chat media, as without a server). */
  link: () => ContentLink | null;
  grants?: FileGrants;
  audit?: (text: string) => void;
  timeoutMs?: number;
}

/** Serves the renderer's chat media and `botling-content:` URLs from the server's references. */
export class ContentProtocol {
  readonly grants: FileGrants;

  constructor(private readonly options: ContentProtocolOptions) {
    this.grants = options.grants ?? fileGrants;
  }

  private ask(link: ContentLink, message: Parameters<ContentLink["content"]>[0]): Promise<ContentAnswer> {
    const ms = this.options.timeoutMs ?? ANSWER_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("the Botling server did not answer")), ms); });
    return Promise.race([link.content(message), timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * A chat-origin attachment request (`/attachment/<bot>/<ref>/<name>?line=<id>`): the line's pinned version, or a
   * gone answer. Null when the server holds no reference for it (the 2.x handler answers then).
   */
  async chatAttachment(url: URL, request: Request): Promise<Response | null> {
    const target = attachmentTarget(url.pathname);
    const line = attachmentLine(url.searchParams);
    if (!target || !line || !/^file:/i.test(target.ref)) return null;
    const link = this.options.link();
    if (!link) return null;
    let found: ContentAnswer;
    try {
      found = await this.ask(link, { t: "content.find", botId: target.botId, line, url: target.ref });
    } catch (error) {
      this.options.audit?.(`content: find failed: ${String((error as Error)?.message ?? error)}`);
      return null;
    }
    if (found.t !== "content.found" || !found.ref) return null;
    return this.serveFound(link, found.ref, request, { botId: target.botId, line, url: target.ref });
  }

  private async serveFound(link: ContentLink, ref: NonNullable<MessageOf<"content.found">["ref"]>, request: Request, again: { botId: string; line: string; url: string } | null, variant = "original"): Promise<Response> {
    if (ref.state === "changed") return goneResponse("changed");
    if (ref.state === "gone") return goneResponse("deleted");
    let opened: ContentAnswer;
    try {
      opened = await this.ask(link, { t: "content.open", owner: ref.owner, id: ref.id, variant, entry: ref.entry });
    } catch {
      return goneResponse("offline");
    }
    if (opened.t === "content.file") return serveContentFile(opened, request, { csp: CHAT_MEDIA_CSP });
    if (opened.t !== "content.gone") return goneResponse("deleted");
    // The hash became ready between find and open: the line's rows moved to the content id. Ask once more.
    if (again && ref.id.startsWith("pending:") && (opened.reason === "denied" || opened.reason === "deleted")) {
      try {
        const found = await this.ask(link, { t: "content.find", ...again });
        if (found.t === "content.found" && found.ref && found.ref.id !== ref.id) return this.serveFound(link, found.ref, request, null);
      } catch { /* answered below */ }
    }
    return goneResponse(opened.reason);
  }

  /** `botling-content:` requests. `scope`: "pane" serves only the pane's granted files (web pages share that session). */
  async handle(request: Request, scope: "app" | "pane" = "app"): Promise<Response> {
    let url: URL;
    try { url = new URL(request.url); } catch { return new Response("Not found", { status: 404 }); }
    if (url.host === "file") {
      const path = this.grants.path(`${url.protocol}//${url.host}${url.pathname}`);
      if (!path) return new Response("Not found", { status: 404 });
      try {
        const response = await previewResponse(path, request, { type: "application/pdf", follow: true });
        // Chromium's PDF viewer is a top-level document of its own: no page policy on the PDF response.
        response.headers.delete("Content-Security-Policy");
        return response;
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }
    if (scope !== "app") return new Response("Not found", { status: 404 });
    const parsed = parseContentUrl(url);
    const link = this.options.link();
    if (!parsed) return new Response("Not found", { status: 404 });
    if (!link) return goneResponse("offline");
    return this.serveFound(link, { owner: parsed.owner, id: parsed.id, type: "application/octet-stream", state: "ready", entry: parsed.entry }, request, null, parsed.variant);
  }
}

// ---------------------------------------------------------------------------------------------
// Installing into Electron (content-install.ts passes Electron's objects; tests pass fakes)

/** src/main/browser-host.ts `BROWSER_PARTITION` (not imported: that module must load with the 2.x main, not before it). */
export const PANE_PARTITION = "persist:botling-web";

type Handler = (request: Request) => Response | Promise<Response>;
export interface CustomSchemeLike { scheme: string; privileges?: Record<string, boolean> }
export interface ProtocolLike {
  registerSchemesAsPrivileged(schemes: CustomSchemeLike[]): void;
  handle(scheme: string, handler: Handler): void;
}

export interface InstallDeps {
  protocol: ProtocolLike;
  whenReady: () => Promise<unknown>;
  paneProtocol: () => Pick<ProtocolLike, "handle">;
  content: ContentProtocol;
}

/**
 * Wraps the 2.x main's protocol calls before it makes them:
 * - `registerSchemesAsPrivileged` (main calls it once, at load): `botling-content` joins main's list;
 * - `handle("botling-chat", …)`: a chat attachment of a line the server indexed is answered from the server's reference,
 *   anything else by main's own handler, as in 2.x;
 * - once the app is ready: `botling-content` on the default session (chat media, §9A.4 URLs) and on the browser pane's
 *   session (only the PDFs the user handed over: web pages share that session).
 */
export function installContentProtocol(deps: InstallDeps): void {
  const target = deps.protocol;
  const register = target.registerSchemesAsPrivileged.bind(target);
  const handle = target.handle.bind(target);
  target.registerSchemesAsPrivileged = (schemes) => {
    const list = schemes.some((scheme) => scheme.scheme === CONTENT_SCHEME) ? schemes : [...schemes, { scheme: CONTENT_SCHEME, privileges: { ...CONTENT_PRIVILEGES } }];
    register(list);
  };
  target.handle = (scheme, handler) => {
    if (scheme !== "botling-chat") return handle(scheme, handler);
    return handle(scheme, async (request) => {
      let url: URL | null = null;
      try { url = new URL(request.url); } catch { /* main's handler answers */ }
      if (url && url.host === "chat") {
        const served = await deps.content.chatAttachment(url, request);
        if (served) return served;
      }
      return handler(request);
    });
  };
  void deps.whenReady().then(() => {
    handle(CONTENT_SCHEME, (request) => deps.content.handle(request, "app"));
    deps.paneProtocol().handle(CONTENT_SCHEME, (request) => deps.content.handle(request, "pane"));
  });
}
