// The shell's side of a line's media (M2 steps 9 and 11, protocol v1 §9A.4 tailnet part, §9A.5, §9A.6). The chat frame
// names a line's file (`media.want`); the shell asks the server over the session which reference the line holds for it
// (`content.locate`, with the variants and size since step 11) and answers the frame with what to load, or the
// reference's state (`preparing`, `changed`, `gone`, `none`, `failed`).
//
// - A `preparing` reference is asked again when the line's `content.ready` entry arrives (and, failing that, every few
//   seconds for a while); the frame shows "preparing" meanwhile, never a broken element.
// - Video (step 11): the poster comes from the content cache by its hash (fetched once, then kept), with the duration
//   and size; the variant follows the 1.5× rule (player.ts) on this session's measured rate and this device's choice;
//   both URLs go to the frame so it can switch after two stalls. A `content.variant` entry (a preview made later)
//   updates the answer.
// - Images ≤ 2 MB and PDF page-1 thumbnails are cached by hash too and handed over as `data:` URLs (the frame's opaque
//   origin cannot read the shell's Cache Storage).
// - A `content.changed{id}` entry turns every file with that id into `changed` at once: the frame hides the element.
// - A failure the frame reports is asked about again at most once (after a back-off); a second failure is `failed`.
// - Tickets live 10 minutes on the server; while the session lives the shell asks `content.ticket` for each ready file
//   every RENEW_MS, which renews the same ticket (the URL a playing `<video>` holds stays valid).
// - A ready PDF (step 15) carries its prepared text's URL (the owner's `text` variant) besides its own; a tap in the
//   frame (`media.open`) opens the viewer (pdf-overlay.ts) over the page with both.
// - Nothing about permissions is stored: tickets live in memory only, and a new page asks again.
// - The relay path (step 14): with the page's service worker in control (sw-bridge.ts), every URL handed out is a bridge
//   URL (`sw=1`), which the worker answers over the session; posters, images and PDFs are read from the page (or its
//   same-origin viewer), which the worker controls. A video is played in the page's own player (video-overlay.ts): the
//   chat frame, which no worker controls, shows its poster and opens the player on a tap (`open: "player"`).
import type { FeLink, RemoteContentAnswer } from "../../src/fe-link";
import { contentUrlPath, type ContentVariant, type EntryRef } from "../../src/protocol";
import { kindOfType, type FrameMediaMessage, type MediaAnswer, type MediaKind, type MediaState, type MediaWant, type ShellMediaMessage } from "../media-wire";
import { chooseVariant, PATH_LABEL, RateMeter, type Choice, type PathKind, type VariantName } from "../player";
import { CONTENT_ITEM_MAX, type ContentCache } from "./content-cache";
import { openPdfViewer } from "./pdf-overlay";
import type { SwBridge } from "./sw-bridge";
import { newVideoDiagnostics, openVideoPlayer, type VideoDiagnostics } from "./video-overlay";

/** How often a ready file's ticket is renewed (the server keeps one 10 minutes). */
export const RENEW_MS = 4 * 60 * 1000;
/** How often a `preparing` file is asked again when its `content.ready` did not come, and how many times. */
export const PREPARING_RETRY_MS = 3_000;
export const PREPARING_RETRIES = 40;
/** The back-off before a failed file is located again (once). */
export const FAILED_RETRY_MS = 1_000;
/** A stalled element is checked with the server at most this often. */
export const STALL_CHECK_MS = 10_000;
/** The name of this device's player choice in its store (the shell's origin; the frame has no storage). */
export const CHOICE_KEY = "player-choice";

/** Where the shell keeps a small setting (IndexedDB beside the device record, D45). */
export interface PrefStore {
  load(name: string): Promise<string | null>;
  save(name: string, value: string): Promise<void>;
}

interface Known {
  want: MediaWant;
  answer: MediaAnswer;
  ref?: { owner: string; id: string; entry: EntryRef; type: string; size?: number };
  ticket?: string;
  variants: ContentVariant[];
  retries: number;
  /** Failures reported and located again (at most one). */
  relocated: number;
  lastStallCheck: number;
  /** Set after the frame switched to the preview (two stalls): later answers keep the preview. */
  switched: boolean;
}

export interface MediaDiagnostics {
  [key: string]: { state: MediaState; src?: string; url?: string; textUrl?: string; opened?: number; variant?: VariantName; badge?: string; reason?: string; poster?: "cache" | "fetched" | "memory"; durationMs?: number };
}

export interface PlayerDiagnostics {
  path: PathKind; rateBps: number; measured: boolean; samples: number; switches: number; choice: Choice;
  /** Why each switch to the preview happened, oldest first (at most 20). */
  switchedBy: string[];
  cache: { hits: number; fetched: number; kept: number; cleared: string[] };
}

export interface MediaBrokerOptions {
  cache?: ContentCache | null;
  path?: PathKind;
  player?: PlayerDiagnostics;
  fetch?: typeof fetch;
  storage?: PrefStore | null;
  /** The content bridge on the relay path (step 14). */
  bridge?: SwBridge | null;
  /** The player over the page (step 14). */
  video?: VideoDiagnostics;
}

export function newPlayerDiagnostics(path: PathKind): PlayerDiagnostics {
  return { path, rateBps: 0, measured: false, samples: 0, switches: 0, choice: "auto", switchedBy: [], cache: { hits: 0, fetched: 0, kept: 0, cleared: [] } };
}

/** A file URL's last path part, decoded ("report.pdf"). */
function nameOf(url: string, fallback = "document.pdf"): string {
  const path = url.replace(/^file:\/\//i, "").split(/[?#]/)[0] ?? "";
  const last = path.split("/").pop() || fallback;
  try { return decodeURIComponent(last); } catch { return last; }
}

const toDataUrl = (bytes: ArrayBuffer, type: string): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error("read failed"));
  reader.readAsDataURL(new Blob([bytes], { type }));
});

export class MediaBroker {
  private readonly known = new Map<string, Known>();
  private readonly waiting = new Set<string>();
  private readonly inflight = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private readonly offs: Array<() => void> = [];
  /** Data URLs of cached items by hash (this page's life), so a re-render does not read the cache again. */
  private readonly dataUrls = new Map<string, Promise<string | null>>();
  readonly meter: RateMeter;
  private choice: Choice = "auto";
  private readonly cache: ContentCache | null;
  private readonly fetchImpl: typeof fetch;
  private readonly storage: PrefStore | null;
  private readonly player: PlayerDiagnostics;
  private readonly bridge: SwBridge | null;
  /** Whether bridge URLs are handed out (the worker controls the page); null until known. */
  private bridgeOn: boolean | null = null;
  readonly video: VideoDiagnostics;

  constructor(private readonly link: FeLink, private readonly frame: () => Window | null, private readonly diag?: MediaDiagnostics, options: MediaBrokerOptions = {}) {
    this.cache = options.cache ?? null;
    this.meter = new RateMeter(options.path ?? "tailnet");
    this.player = options.player ?? newPlayerDiagnostics(this.meter.path);
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.storage = options.storage ?? null;
    this.bridge = options.bridge ?? null;
    this.video = options.video ?? newVideoDiagnostics();
    if (!this.bridge) this.bridgeOn = false;
    else void this.bridge.ready.then((on) => { this.bridgeOn = on; });
    this.syncPlayer();
    // The kept choice arrives a moment later; videos answered meanwhile are answered again.
    void this.storage?.load(CHOICE_KEY).then((saved) => {
      if ((saved === "original" || saved === "preview") && this.choice === "auto") this.applyChoice(saved);
    }, () => undefined);
  }

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

  /** Forgets what this page holds in memory of cached bytes (after the cache was cleared). */
  dropCached(): void { this.dataUrls.clear(); }

  private syncPlayer(): void {
    this.player.rateBps = this.meter.bps;
    this.player.measured = this.meter.measured;
    this.player.samples = this.meter.count;
    this.player.choice = this.choice;
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
        this.known.set(item.key, { want: { key: item.key, botId: item.botId, line: item.line, url: item.url }, answer: { key: item.key, state: "preparing" }, variants: [], retries: 0, relocated: 0, lastStallCheck: 0, switched: false });
        void this.locate(item.key);
      }
    } else if (data.botling3 === "media.failed" && typeof data.key === "string") {
      const known = this.known.get(data.key);
      if (!known) return;
      if (typeof data.src === "string" && known.answer.src && data.src !== known.answer.src && !Object.values(known.answer.sources ?? {}).some((s) => s?.src === data.src)) return;
      if (data.reason === "stalled") this.checkStalled(known);
      else this.failed(known);
    } else if (data.botling3 === "media.rate" && typeof data.bytes === "number" && typeof data.ms === "number") {
      if (this.meter.sample(data.bytes, data.ms)) this.syncPlayer();
    } else if (data.botling3 === "media.switched" && typeof data.key === "string") {
      const known = this.known.get(data.key);
      if (known) this.switchedToPreview(known, data.why === "slow-start" ? "slow-start" : "stalls");
    } else if (data.botling3 === "media.open" && typeof data.key === "string") {
      const known = this.known.get(data.key);
      if (known?.answer.state === "ready" && known.answer.kind === "video" && known.answer.open === "player") { this.openVideo(known); return; }
      if (!known || known.answer.state !== "ready" || known.answer.kind !== "pdf" || !known.answer.url) return;
      const answer = known.answer;
      openPdfViewer({ src: answer.url!, ...(answer.textUrl ? { text: answer.textUrl } : {}), name: nameOf(known.want.url), ...(answer.size !== undefined ? { size: answer.size } : {}), relay: this.meter.path === "relay" });
      if (this.diag?.[data.key]) this.diag[data.key]!.opened = (this.diag[data.key]!.opened ?? 0) + 1;
    } else if (data.botling3 === "media.choice" && (data.choice === "auto" || data.choice === "original" || data.choice === "preview")) {
      void this.storage?.save(CHOICE_KEY, data.choice).catch(() => undefined);
      this.applyChoice(data.choice);
    }
  }

  /** A playing original gave way to the preview (two stalls, or slow start): the session's rate is capped below it. */
  private switchedToPreview(known: Known, why: "stalls" | "slow-start"): void {
    const original = known.answer.sources?.original;
    if (original?.bitrate) this.meter.stalledAt(original.bitrate);
    known.switched = true;
    this.player.switches += 1;
    this.player.switchedBy.push(why);
    if (this.player.switchedBy.length > 20) this.player.switchedBy.shift();
    this.syncPlayer();
    void this.answerReady(known);
  }

  /** The relay path's player over the page for a ready video (step 14), with the step 11 rules. */
  private openVideo(known: Known): void {
    const answer = known.answer;
    if (!answer.src || !answer.sources) return;
    openVideoPlayer({
      key: answer.key, name: nameOf(known.want.url, "video"), src: answer.src, variant: answer.variant ?? "original", sources: answer.sources,
      ...(answer.poster ? { poster: answer.poster } : {}), ...(answer.pathLabel ? { pathLabel: answer.pathLabel } : {}),
    }, {
      rate: (bytes, ms) => { if (this.meter.sample(bytes, ms)) this.syncPlayer(); },
      switched: (key, why) => { const k = this.known.get(key); if (k) this.switchedToPreview(k, why); },
      failed: (key, reason) => { const k = this.known.get(key); if (!k) return; if (reason === "stalled") this.checkStalled(k); else this.failed(k); },
    }, this.video);
    if (this.diag?.[answer.key]) this.diag[answer.key]!.opened = (this.diag[answer.key]!.opened ?? 0) + 1;
  }

  /** This device's choice in the player menu: every ready video is answered again under it. */
  private applyChoice(choice: Choice): void {
    this.choice = choice;
    this.syncPlayer();
    for (const known of this.known.values()) {
      if (known.answer.kind === "video" && known.answer.state === "ready") { known.switched = false; void this.answerReady(known); }
    }
  }

  private onEntry(kind: string, body: unknown): void {
    const value = body as { botId?: string; lineId?: string; id?: string; variant?: ContentVariant } | null;
    if (kind === "content.ready" && value?.botId && value.lineId) {
      for (const known of this.known.values()) {
        if (known.want.botId === value.botId && known.want.line === value.lineId && known.answer.state !== "ready") void this.locate(known.want.key);
      }
    } else if (kind === "content.variant" && value?.id && value.variant && typeof value.variant.name === "string") {
      for (const known of this.known.values()) {
        if (known.ref?.id !== value.id || known.answer.state !== "ready") continue;
        const variant = value.variant;
        known.variants = [...known.variants.filter((v) => v.name !== variant.name), variant];
        void this.answerReady(known);
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
    known.ref = { owner: ref.owner, id: ref.id, entry: ref.entry, type: ref.type, ...(ref.size !== undefined ? { size: ref.size } : {}) };
    if (ref.state === "ready" && answer.ticket) {
      known.ticket = answer.ticket;
      // Variants the server lists now, plus any a `content.variant` entry told of meanwhile.
      const listed = answer.variants ?? [];
      known.variants = [...listed, ...known.variants.filter((v) => !listed.some((l) => l.name === v.name))];
      await this.answerReady(known);
      return;
    }
    if (ref.state === "changed" || ref.state === "gone") {
      this.set(known, { key, state: ref.state });
    } else {
      this.set(known, { key, state: "preparing" });
      if (known.retries++ < PREPARING_RETRIES) this.later(() => { if (this.known.get(key)?.answer.state === "preparing") void this.locate(key); }, PREPARING_RETRY_MS);
    }
    this.post([known.answer]);
  }

  private url(known: Known, variant: string): string {
    const ref = known.ref!;
    const url = contentUrlPath({ owner: ref.owner, id: ref.id, variant, entry: ref.entry, ticket: known.ticket! });
    return this.bridge && this.bridgeOn ? this.bridge.url(url) : url;
  }

  /** Builds and posts the answer of a ready file from its reference, variants, the cache and the player rule. */
  private async answerReady(known: Known): Promise<void> {
    const ref = known.ref;
    if (!ref || !known.ticket) return;
    // The relay path: wait until the worker controls the page (or failed to), so the URLs are the bridge's.
    if (this.bridge && this.bridgeOn === null) this.bridgeOn = await this.bridge.ready;
    const key = known.want.key;
    const kind: MediaKind = kindOfType(ref.type);
    const byName = new Map(known.variants.map((v) => [v.name, v]));
    const size = ref.size ?? byName.get("original")?.size;
    const base: MediaAnswer = { key, state: "ready", kind, url: this.url(known, "original"), ...(size !== undefined ? { size } : {}), pathLabel: PATH_LABEL[this.meter.path] };
    const extra: MediaDiagnostics[string] = { state: "ready" };
    if (kind === "video") {
      const original = byName.get("original");
      const preview = byName.get("preview");
      const decision = known.switched && preview ? { variant: "preview" as const, reason: "switched", badge: "preview" } : chooseVariant({ original: { ...(original?.bitrate ? { bitrate: original.bitrate } : {}) }, ...(preview ? { preview: { ...(preview.bitrate ? { bitrate: preview.bitrate } : {}) } } : {}) }, this.meter.bps, this.choice);
      const sources: MediaAnswer["sources"] = { original: { src: this.url(known, "original"), ...(original?.bitrate ? { bitrate: original.bitrate } : {}) } };
      if (preview) sources.preview = { src: this.url(known, "preview"), ...(preview.bitrate ? { bitrate: preview.bitrate } : {}) };
      if (this.bridgeOn) base.open = "player";
      Object.assign(base, { src: sources[decision.variant]!.src, variant: decision.variant, sources, choice: this.choice, ...(decision.badge ? { badge: decision.badge } : {}), ...(original?.durationMs ? { durationMs: original.durationMs } : {}) });
      Object.assign(extra, { variant: decision.variant, reason: decision.reason, ...(decision.badge ? { badge: decision.badge } : {}), ...(original?.durationMs ? { durationMs: original.durationMs } : {}) });
      const poster = byName.get("poster");
      if (poster) {
        const cached = await this.cachedDataUrl(poster.id, () => this.url(known, "poster"), poster.size, extra);
        if (cached) base.poster = cached;
      }
    } else if (kind === "image") {
      // An image ≤ 2 MB comes from the cache (fetched once by hash); a larger one loads directly.
      const small = size !== undefined && size <= CONTENT_ITEM_MAX;
      const cached = small ? await this.cachedDataUrl(ref.id, () => this.url(known, "original"), size, extra) : null;
      base.src = cached ?? this.url(known, "original");
    } else if (kind === "pdf") {
      // The 2.x page shows a PDF named as a picture as an <img>: its page-1 thumbnail (cached), else a card. The viewer is step 15.
      const thumb = byName.get("thumb");
      const cached = thumb ? await this.cachedDataUrl(thumb.id, () => this.url(known, "thumb"), thumb.size, extra) : null;
      if (cached) base.src = cached;
      if (byName.has("text")) base.textUrl = this.url(known, "text");
    } else {
      base.src = this.url(known, "original");
    }
    // A newer state (changed while the poster loaded) wins.
    if (this.known.get(key) !== known || (known.answer.state !== "ready" && known.answer.state !== "preparing" && known.answer.state !== "failed" && known.answer.state !== "none")) return;
    this.set(known, base, extra);
    this.post([known.answer]);
  }

  /** A cached item's `data:` URL: from the page's memory, the content cache, or fetched once and kept. */
  private cachedDataUrl(id: string, url: () => string, size: number | undefined, extra: MediaDiagnostics[string]): Promise<string | null> {
    const held = this.dataUrls.get(id);
    if (held) { extra.poster = "memory"; return held; }
    const promise = (async () => {
      try {
        const hit = await this.cache?.get(id);
        if (hit) { this.player.cache.hits += 1; extra.poster = "cache"; return await toDataUrl(hit.bytes, hit.type); }
        if (size !== undefined && size > CONTENT_ITEM_MAX) return null;
        const t0 = performance.now();
        const response = await this.fetchImpl(url(), { credentials: "omit", cache: "no-store" });
        if (response.status !== 200) return null;
        const bytes = await response.arrayBuffer();
        if (this.meter.sample(bytes.byteLength, performance.now() - t0)) this.syncPlayer();
        const type = response.headers.get("content-type") ?? "application/octet-stream";
        this.player.cache.fetched += 1;
        extra.poster = "fetched";
        if (await this.cache?.put(id, bytes, type)) this.player.cache.kept += 1;
        return await toDataUrl(bytes, type);
      } catch { return null; }
    })();
    this.dataUrls.set(id, promise);
    void promise.then((value) => { if (value === null && this.dataUrls.get(id) === promise) this.dataUrls.delete(id); });
    return promise;
  }

  /** An element failed to load: located again once after a back-off; a second failure is final. */
  private failed(known: Known): void {
    if (known.relocated >= 1) {
      if (known.answer.state === "failed") return;
      this.set(known, { key: known.want.key, state: "failed" });
      this.post([known.answer]);
      return;
    }
    known.relocated += 1;
    this.later(() => { if (this.known.get(known.want.key) === known) void this.locate(known.want.key); }, FAILED_RETRY_MS);
  }

  /** An element sits stalled without bytes: ask the server whether the file may still be read (at most every 10 s). */
  private checkStalled(known: Known): void {
    const now = Date.now();
    if (now - known.lastStallCheck < STALL_CHECK_MS || !known.ref || this.link.state !== "live") return;
    known.lastStallCheck = now;
    const ref = known.ref;
    void this.link.remoteContent({ t: "content.ticket", owner: ref.owner, id: ref.id, entry: ref.entry }).then((answer: RemoteContentAnswer) => {
      if (answer.t === "content.gone") {
        this.set(known, { key: known.want.key, state: answer.reason === "changed" ? "changed" : "gone" });
        this.post([known.answer]);
      } else if (answer.t === "content.granted" && answer.ticket !== known.ticket) {
        known.ticket = answer.ticket;
        void this.answerReady(known);
      }
    }, () => undefined);
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
        } else if (answer.t === "content.granted" && answer.ticket !== known.ticket) {
          known.ticket = answer.ticket;
          void this.answerReady(known);
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

  private set(known: Known, answer: MediaAnswer, extra?: MediaDiagnostics[string]): void {
    known.answer = answer;
    if (this.diag) this.diag[answer.key] = { ...(extra ?? {}), state: answer.state, ...(answer.src ? { src: answer.src.startsWith("data:") ? "data:" : answer.src } : {}), ...(answer.url ? { url: answer.url } : {}), ...(answer.textUrl ? { textUrl: answer.textUrl } : {}), ...(this.diag[answer.key]?.opened ? { opened: this.diag[answer.key]!.opened } : {}) };
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
