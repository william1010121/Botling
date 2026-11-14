// The shell's side of a line's media (M2 step 9, protocol v1 §9A.4 tailnet part, brief Q1). The chat frame names a
// line's file (`media.want`); the shell asks the server over the session which reference the line holds for it
// (`content.locate`) and answers the frame with the `/v3/c/<owner>/<id>/original?e=<stream>.<seq>&t=<ticket>` URL, or
// the reference's state (`preparing`, `changed`, `gone`, `none`).
//
// - A `preparing` reference is asked again when the line's `content.ready` entry arrives (and, failing that, every few
//   seconds for a while).
// - A `content.changed{id}` entry turns every file with that id into `changed` at once: the frame hides the element and
//   says so; it never loads other bytes (the server would refuse them anyway, §9A.3).
// - Tickets live 10 minutes on the server; while the session lives the shell asks `content.ticket` for each ready file
//   every RENEW_MS, which renews the same ticket (the URL a playing `<video>` holds stays valid).
// - Nothing here is stored: tickets live in memory only, and a new page asks again.
import type { FeLink, RemoteContentAnswer } from "../../src/fe-link";
import { contentUrlPath, type EntryRef } from "../../src/protocol";
import type { FrameMediaMessage, MediaAnswer, MediaState, MediaWant, ShellMediaMessage } from "../media-wire";

/** How often a ready file's ticket is renewed (the server keeps one 10 minutes). */
export const RENEW_MS = 4 * 60 * 1000;
/** How often a `preparing` file is asked again when its `content.ready` did not come, and how many times. */
export const PREPARING_RETRY_MS = 3_000;
export const PREPARING_RETRIES = 40;

interface Known {
  want: MediaWant;
  answer: MediaAnswer;
  ref?: { owner: string; id: string; entry: EntryRef };
  retries: number;
}

export interface MediaDiagnostics { [key: string]: { state: MediaState; src?: string } }

export class MediaBroker {
  private readonly known = new Map<string, Known>();
  private readonly waiting = new Set<string>();
  private readonly inflight = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private readonly offs: Array<() => void> = [];

  constructor(private readonly link: FeLink, private readonly frame: () => Window | null, private readonly diag?: MediaDiagnostics) {}

  start(): void {
    const onMessage = (event: MessageEvent) => this.onFrame(event);
    window.addEventListener("message", onMessage);
    this.offs.push(() => window.removeEventListener("message", onMessage));
    this.offs.push(this.link.on((event) => {
      if (event.type === "state" && event.status.state === "live") this.flush();
      if (event.type === "entries") for (const entry of event.entries) this.onEntry(entry.kind, entry.body);
    }));
    this.renewTimer = setInterval(() => this.renew(), RENEW_MS);
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
  }

  private onFrame(event: MessageEvent): void {
    const frame = this.frame();
    if (!frame || event.source !== frame) return;
    const data = event.data as FrameMediaMessage | null;
    if (!data || typeof data !== "object") return;
    if (data.botling3 === "media.want" && Array.isArray(data.items)) {
      for (const item of data.items) {
        if (!item || typeof item.key !== "string" || typeof item.botId !== "string" || typeof item.line !== "string" || typeof item.url !== "string") continue;
        const known = this.known.get(item.key);
        if (known && known.answer.state !== "none") { this.post([known.answer]); continue; }
        this.known.set(item.key, { want: { key: item.key, botId: item.botId, line: item.line, url: item.url }, answer: { key: item.key, state: "preparing" }, retries: 0 });
        void this.locate(item.key);
      }
    } else if (data.botling3 === "media.failed" && typeof data.key === "string" && this.known.has(data.key)) {
      void this.locate(data.key);
    }
  }

  private onEntry(kind: string, body: unknown): void {
    const value = body as { botId?: string; lineId?: string; id?: string } | null;
    if (kind === "content.ready" && value?.botId && value.lineId) {
      for (const known of this.known.values()) {
        if (known.want.botId === value.botId && known.want.line === value.lineId && known.answer.state !== "ready") void this.locate(known.want.key);
      }
    } else if (kind === "content.changed" && value?.id) {
      const changed: MediaAnswer[] = [];
      for (const known of this.known.values()) {
        if (known.ref?.id === value.id && known.answer.state !== "changed") { this.set(known, { key: known.want.key, state: "changed" }); changed.push(known.answer); }
      }
      if (changed.length) this.post(changed);
    }
  }

  private async locate(key: string): Promise<void> {
    const known = this.known.get(key);
    if (!known || this.inflight.has(key)) return;
    if (this.link.state !== "live") { this.waiting.add(key); return; }
    this.inflight.add(key);
    let answer: RemoteContentAnswer;
    try {
      answer = await this.link.remoteContent({ t: "content.locate", botId: known.want.botId, line: known.want.line, url: known.want.url });
    } catch {
      this.waiting.add(key);
      return;
    } finally {
      this.inflight.delete(key);
    }
    if (answer.t !== "content.located") return;
    const ref = answer.ref;
    if (!ref) { this.set(known, { key, state: "none" }); this.post([known.answer]); return; }
    known.ref = { owner: ref.owner, id: ref.id, entry: ref.entry };
    if (ref.state === "ready" && answer.ticket) {
      this.set(known, { key, state: "ready", src: contentUrlPath({ owner: ref.owner, id: ref.id, variant: "original", entry: ref.entry, ticket: answer.ticket }) });
    } else if (ref.state === "changed" || ref.state === "gone") {
      this.set(known, { key, state: ref.state });
    } else {
      this.set(known, { key, state: "preparing" });
      if (known.retries++ < PREPARING_RETRIES) this.later(() => { if (this.known.get(key)?.answer.state === "preparing") void this.locate(key); }, PREPARING_RETRY_MS);
    }
    this.post([known.answer]);
  }

  /** Renews the ticket of every ready file (the same ticket comes back), or learns that it changed. */
  private renew(): void {
    if (this.link.state !== "live") return;
    for (const known of this.known.values()) {
      if (known.answer.state !== "ready" || !known.ref || !known.ref.id.startsWith("sha256:")) continue;
      const ref = known.ref;
      void this.link.remoteContent({ t: "content.ticket", owner: ref.owner, id: ref.id, entry: ref.entry }).then((answer: RemoteContentAnswer) => {
        if (answer.t === "content.gone") {
          this.set(known, { key: known.want.key, state: answer.reason === "changed" ? "changed" : "gone" });
          this.post([known.answer]);
        } else if (answer.t === "content.granted") {
          const src = contentUrlPath({ owner: ref.owner, id: ref.id, variant: "original", entry: ref.entry, ticket: answer.ticket });
          if (src !== known.answer.src) { this.set(known, { key: known.want.key, state: "ready", src }); this.post([known.answer]); }
        }
      }, () => undefined);
    }
  }

  /** Back on the session: asks for every file that waited. */
  private flush(): void {
    const keys = [...this.waiting];
    this.waiting.clear();
    for (const key of keys) void this.locate(key);
  }

  private set(known: Known, answer: MediaAnswer): void {
    known.answer = answer;
    if (this.diag) this.diag[answer.key] = { state: answer.state, ...(answer.src ? { src: answer.src } : {}) };
  }

  private post(items: MediaAnswer[]): void {
    const message: ShellMediaMessage = { botling3: "media", items };
    // The chat frame has an opaque origin: it can only be named "*" (it checks that the message came from its parent).
    this.frame()?.postMessage(message, "*");
  }

  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms);
    this.timers.add(timer);
  }
}

