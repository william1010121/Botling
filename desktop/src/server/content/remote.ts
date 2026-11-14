// Content over the tailnet (M2 step 9, protocol v1 §9A.4, §9A.7; brief Q1): a paired device's page reads the bytes of a
// chat line's file from `/v3/c/<owner>/<id>/<variant>?e=<stream>.<seq>&t=<ticket>` on the loopback listener (published
// on the tailnet by `tailscale serve`), with HTTP byte ranges answered exactly as M1's local path answers them
// (main-v3/content-protocol.ts `serveContentFile`, i.e. 2.x preview-response.ts).
//
// - `content.locate` (over the device's session): which reference a line holds for a file, with a ticket once hashed.
// - `content.ticket` (over the session): a ticket for a known reference; asked again before it expires, it is renewed
//   under the same text (tickets.ts).
// - Every HTTP request is checked again, in this order: the URL parses; the ticket is known and unexpired; it was given
//   for exactly this owner, id and entry; its device is valid in the roster now with the `read` scope; the entry
//   references the id in a stream the device may read (service.ts `open` with `remote`). Then the pinned bytes are
//   served; a `pin: path` file that no longer matches answers `changed` (and the server appends `content.changed`),
//   never other bytes.
// - The answer carries `Cross-Origin-Resource-Policy: cross-origin`: the chat runs in a sandboxed, opaque-origin frame
//   whose media requests are cross-site (the Q1 spike). The ticket is the credential; it is never written to a log.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { CHAT_MEDIA_CSP, goneResponse, serveContentFile } from "../../main-v3/content-protocol";
import { contentUrlForLog, parseContentUrl, type MessageOf } from "../../protocol";
import type { DeviceRoster } from "../session/remote-reads";
import type { PeerContent } from "./peer-content";
import type { ContentService } from "./service";
import type { ContentTickets } from "./tickets";

export interface RemoteContentOptions {
  service: Pick<ContentService, "serverId" | "locate" | "open" | "markChanged"> & Partial<Pick<ContentService, "describe">>;
  tickets: ContentTickets;
  roster: Pick<DeviceRoster, "device">;
  log?: (text: string) => void;
  /**
   * M3 step 10: content owned by a peer server (peer-content.ts). Lookups of a peer's bot's lines, tickets for a
   * peer's reference and `/v3/c/<peer>/…` requests go there, after the same ticket and device checks.
   */
  peer?: Pick<PeerContent, "ownerOfBot" | "locate" | "check" | "respond"> | null;
}

/** Why an HTTP request was refused before any file was looked at (the `X-Botling-Content` header names it). */
export type Refusal = "malformed" | "no-ticket" | "ticket" | "binding" | "device";

const REFUSAL_STATUS: Record<Refusal, number> = { malformed: 404, "no-ticket": 403, ticket: 403, binding: 403, device: 403 };

export class RemoteContent {
  constructor(private readonly options: RemoteContentOptions) {}

  private readable(deviceId: string): boolean {
    const device = this.options.roster.device(deviceId);
    return !!device && (device.scope ?? []).includes("read");
  }

  /** `content.locate` from a device's session (its validity was checked for the frame). */
  async locate(deviceId: string, message: MessageOf<"content.locate">): Promise<MessageOf<"content.located">> {
    const none: MessageOf<"content.located"> = { t: "content.located", req: message.req, ref: null };
    if (!this.readable(deviceId)) return none;
    const peer = this.options.peer && this.options.peer.ownerOfBot(message.botId) ? this.options.peer : null;
    const found = peer ? await peer.locate(deviceId, message) : this.options.service.locate(message);
    if (!found) return none;
    const ref = { owner: found.owner, id: found.id, type: found.type, state: found.state, entry: found.entry };
    if (found.state !== "ready" || !found.id.startsWith("sha256:")) return { ...none, ref };
    const { ticket, expiresAt } = this.options.tickets.issue({ deviceId, owner: found.owner, id: found.id, entry: found.entry });
    const described = this.options.service.describe?.(found.id) ?? null;
    const variants = described?.variants ?? [];
    return { ...none, ref: { ...ref, ...(described ? { size: described.size } : {}) }, ticket, expiresAt, ...(variants.length ? { variants } : {}) };
  }

  /** `content.ticket` from a device's session: a ticket (new or renewed) for an entry that references the id. */
  async ticket(deviceId: string, message: MessageOf<"content.ticket">): Promise<MessageOf<"content.granted"> | MessageOf<"content.gone">> {
    const gone = (reason: MessageOf<"content.gone">["reason"]): MessageOf<"content.gone"> => ({ t: "content.gone", req: message.req, id: message.id, reason });
    if (!this.readable(deviceId)) return gone("denied");
    if (message.owner !== this.options.service.serverId && this.options.peer) {
      const checked = await this.options.peer.check(deviceId, message.owner, message.id, message.entry);
      if (checked !== "ok") return gone(checked === "corrupt" || checked === "cancelled" ? "offline" : checked);
      const { ticket, expiresAt } = this.options.tickets.issue({ deviceId, owner: message.owner, id: message.id, entry: message.entry });
      return { t: "content.granted", req: message.req, ticket, expiresAt };
    }
    const opened = await this.options.service.open({ t: "content.open", req: message.req, owner: message.owner, id: message.id, variant: "original", entry: message.entry }, { remote: true });
    if (opened.t === "content.gone") return gone(opened.reason);
    const { ticket, expiresAt } = this.options.tickets.issue({ deviceId, owner: message.owner, id: message.id, entry: message.entry });
    return { t: "content.granted", req: message.req, ticket, expiresAt };
  }

  /** The web Response for a `/v3/c/…` request (path with query), or a refusal. */
  async respond(pathAndQuery: string, request: Request): Promise<Response> {
    const url = parseContentUrl(pathAndQuery);
    if (!url) return refused("malformed");
    if (!url.ticket) return refused("no-ticket");
    const grant = this.options.tickets.check(url.ticket);
    if (!grant) return refused("ticket");
    if (grant.owner !== url.owner || grant.id !== url.id || grant.entry.stream !== url.entry.stream || grant.entry.seq !== url.entry.seq) return refused("binding");
    if (!this.readable(grant.deviceId)) { this.options.tickets.dropDevice(grant.deviceId); return refused("device"); }
    // M3 step 10: another server's content passes through this one (checked there and at the owner).
    if (url.owner !== this.options.service.serverId && this.options.peer) return this.options.peer.respond(url, request, grant.deviceId);
    const opened = await this.options.service.open({ t: "content.open", req: "http", owner: url.owner, id: url.id, variant: url.variant, entry: url.entry }, { remote: true });
    if (opened.t === "content.gone") return goneResponse(opened.reason);
    return serveContentFile(opened, request, {
      csp: CHAT_MEDIA_CSP,
      onChanged: () => { void this.options.service.markChanged(opened.id).catch(() => undefined); },
    });
  }

  /** Answers one HTTP request of the listener (GET or HEAD under `/v3/c/`). */
  async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathAndQuery = request.url ?? "";
    const range = request.headers.range;
    const web = new Request(`http://127.0.0.1${pathAndQuery.startsWith("/") ? pathAndQuery : "/"}`, { method: request.method === "HEAD" ? "HEAD" : "GET", headers: range ? { range } : {} });
    let answer: Response;
    try {
      answer = await this.respond(pathAndQuery, web);
    } catch (error) {
      this.options.log?.(`content: ${contentUrlForLog(pathAndQuery)} failed: ${String((error as Error)?.message ?? error)}`);
      answer = new Response("Internal error\n", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
    const why = answer.headers.get("X-Botling-Content");
    if (why && answer.status !== 404) this.options.log?.(`content: ${contentUrlForLog(pathAndQuery)} answered ${answer.status} (${why})`);
    await writeResponse(mediaLoaderRefusal(answer, request.headers), request, response);
  }
}

/**
 * WebKit's media loader (its range requests carry `X-Playback-Session-Id`) retries a refused range read of a playing
 * element in a tight loop and never fires the element's `error`: about 3,400 requests in 3 s for a 410, and the same for
 * 403, 404, 416 and 500 (M2 step 11 spike, headless WebKit). An empty `200` ends it after one or two requests; the
 * element then waits, and the page's stall watch asks the server once (`content.ticket`) and hides it. So a refusal of
 * such a request keeps its reason (`X-Botling-Content`, and the status in `X-Botling-Status`) but is sent as an empty
 * 200 with no `Content-Range` (never bytes). Everyone else, Chromium's loader included, gets the status itself.
 */
export function mediaLoaderRefusal(answer: Response, headers: { [name: string]: string | string[] | undefined }): Response {
  if (answer.status < 400 || !headers["x-playback-session-id"] || !headers.range) return answer;
  const out = new Headers({ "Content-Type": "text/plain; charset=utf-8", "Content-Length": "0", "Cache-Control": "no-store", "X-Botling-Status": String(answer.status) });
  const why = answer.headers.get("X-Botling-Content");
  if (why) out.set("X-Botling-Content", why);
  void answer.body?.cancel().catch(() => undefined);
  return new Response(null, { status: 200, headers: out });
}

function refused(why: Refusal): Response {
  return new Response("Not allowed\n", {
    status: REFUSAL_STATUS[why],
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "X-Botling-Content": `refused; reason=${why}` },
  });
}

/** Writes a web Response to a Node response: its status and headers over the listener's, its body with back-pressure. */
export async function writeResponse(answer: Response, request: IncomingMessage, response: ServerResponse): Promise<void> {
  response.statusCode = answer.status;
  answer.headers.forEach((value, name) => { response.setHeader(name, value); });
  // Read from the sandboxed, opaque-origin chat frame (cross-site): the ticket is the credential (Q1).
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (!answer.body || request.method === "HEAD") {
    await answer.body?.cancel().catch(() => undefined);
    response.end();
    return;
  }
  const body = Readable.fromWeb(answer.body as import("node:stream/web").ReadableStream<Uint8Array>, { highWaterMark: 0 });
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    // The player seeked away or closed: stop reading (the file handle closes with the stream).
    response.once("close", () => { if (!response.writableFinished) body.destroy(); finish(); });
    // A `pin: path` chunk that no longer matches ends the body with an error: the connection is cut, never other bytes.
    body.once("error", () => { response.destroy(); finish(); });
    body.pipe(response);
    response.once("finish", finish);
  });
}
