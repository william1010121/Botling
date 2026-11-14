// The player rules of the Botling 3 page (M2 step 11, protocol v1 §9A.5): which variant of a video plays, when a
// playing original gives way to the preview, how fast this session reads, and the words the line shows. Pure: no DOM,
// no timers, so the unit tests drive it with numbers and a fake clock. The shell (shell/media.ts) owns the rate meter
// and the per-device choice; the chat frame (chat-media.ts) owns the stall watch of each playing element.
//
// - **1.5× rule**: play the original when this session's measured rate is at least 1.5 × the original's bitrate,
//   otherwise the preview. Before any measurement the first guess of the path is used (local: unlimited, tailnet:
//   20 Mbit/s, relay: 5 Mbit/s). No preview (not made, or not needed): the original. A device choice ("original" /
//   "preview" from the player's menu) wins over the rule while that variant exists.
// - **Two stalls in 30 s**: a playing original that stalls twice within 30 s switches to the preview at the same
//   position, with a note. A stall is a `waiting` after playback started, not the start itself and not a seek.
// - **Slow start**: WebKit (Safari, every iPhone browser) does not stall: it holds the start until it can play the
//   clip through (it even says `playing` and then holds the clock still), which on a slow path is a long blank wait.
//   So a tapped original whose clock has not moved after 4 s, while its buffer grew slower than 1.5 × real time
//   since the tap (the 1.5× rule, measured), switches too.

export type PathKind = "local" | "tailnet" | "relay";
export type Choice = "auto" | "original" | "preview";
export type VariantName = "original" | "preview";

/** First guesses of a path's rate, in bits per second, before anything was measured (§9A.5). */
export const FIRST_GUESS_BPS: Readonly<Record<PathKind, number>> = { local: Number.POSITIVE_INFINITY, tailnet: 20e6, relay: 5e6 };
/** The original plays when the rate is at least this many times its bitrate. */
export const ORIGINAL_FACTOR = 1.5;
/** Stalls within STALL_WINDOW_MS that switch a playing original to the preview. */
export const STALLS_TO_SWITCH = 2;
export const STALL_WINDOW_MS = 30_000;
/** A tapped original that has not started after this long may switch at once (see `slowStart`). */
export const START_WAIT_MS = 4_000;

/** The words of a path while a tapped video has not shown its first frame after 1 s (§9A.5: the path is named). */
export const PATH_LABEL: Readonly<Record<PathKind, string>> = { local: "loading · on this computer", tailnet: "loading · via tailnet", relay: "loading · via relay" };
export const PREPARING_TEXT = "preparing";
export const SWITCH_NOTE = "Switched to the preview: the connection was too slow for the original.";
export const MAY_BUFFER = "original · may buffer";

/** What the rule needs of a video's variants (from `content.variant` / `content.located`). */
export interface VideoVariants {
  original: { bitrate?: number };
  /** Absent: no preview was made (or none is needed). */
  preview?: { bitrate?: number };
}

export interface Decision {
  variant: VariantName;
  /** Why, for diagnostics and the evidence. */
  reason: "only-original" | "choice" | "rate" | "no-bitrate";
  /** The badge the line shows: "preview" when the preview plays; "original · may buffer" when only the original exists and the rate is short of the rule. */
  badge?: string;
}

/** The 1.5× rule. `rateBps`: the session's rate (measured or first guess), bits per second. */
export function chooseVariant(video: VideoVariants, rateBps: number, choice: Choice = "auto"): Decision {
  const bitrate = video.original.bitrate;
  const fits = bitrate === undefined || bitrate <= 0 || rateBps >= ORIGINAL_FACTOR * bitrate;
  if (!video.preview) return { variant: "original", reason: "only-original", ...(fits ? {} : { badge: MAY_BUFFER }) };
  if (choice === "original") return { variant: "original", reason: "choice" };
  if (choice === "preview") return { variant: "preview", reason: "choice", badge: "preview" };
  if (bitrate === undefined || bitrate <= 0) return { variant: "original", reason: "no-bitrate" };
  return fits ? { variant: "original", reason: "rate" } : { variant: "preview", reason: "rate", badge: "preview" };
}

/**
 * The session's read rate: a moving average of recent content reads (bytes over the time they took). Until the first
 * sample it answers the path's first guess. A switch after two stalls caps it below the original's bitrate (the reads
 * just proved slower than that), so the next video on this session starts on the preview.
 */
export class RateMeter {
  private estimate: number | null = null;
  private samples = 0;
  constructor(readonly path: PathKind, private readonly alpha = 0.3, private readonly minBytes = 32 * 1024, private readonly minMs = 20) {}

  /** Bits per second the rule uses now. */
  get bps(): number { return this.estimate ?? FIRST_GUESS_BPS[this.path]; }
  get measured(): boolean { return this.estimate !== null; }
  get count(): number { return this.samples; }

  /** One read: `bytes` arrived in `ms`. Small or instant reads say little about the rate and are ignored. */
  sample(bytes: number, ms: number): boolean {
    if (!(bytes >= this.minBytes) || !(ms >= this.minMs) || !Number.isFinite(bytes) || !Number.isFinite(ms)) return false;
    const bps = (bytes * 8 * 1000) / ms;
    this.estimate = this.estimate === null ? bps : this.alpha * bps + (1 - this.alpha) * this.estimate;
    this.samples += 1;
    return true;
  }

  /** Two stalls on a video of `bitrate`: this session reads slower than that. */
  stalledAt(bitrate: number): void {
    if (!(bitrate > 0)) return;
    const cap = (bitrate * 0.9);
    this.estimate = this.estimate === null ? cap : Math.min(this.estimate, cap);
  }
}

/**
 * The slow-start rule: `waitedMs` since the tap without the clock moving, while the buffered media ahead grew by
 * `grownS` seconds. Growing slower than 1.5 × real time is the 1.5× rule measured on this clip (media seconds per
 * second × bitrate = the read rate), with no bitrate needed.
 */
export function slowStart(waitedMs: number, grownS: number): boolean {
  return waitedMs >= START_WAIT_MS && grownS < (ORIGINAL_FACTOR * waitedMs) / 1000;
}

/** Counts the stalls of one playing element; `stall()` answers true on the stall that should switch to the preview. */
export class StallWatch {
  private stalls: number[] = [];
  private started = false;
  private seeking = false;
  private switched = false;
  constructor(private readonly windowMs = STALL_WINDOW_MS, private readonly needed = STALLS_TO_SWITCH) {}

  /** `playing`: playback runs (the first one ends the start-up wait, which is not a stall). */
  playing(): void { this.started = true; this.seeking = false; }
  /** `seeking` … `seeked`: a wait while seeking is not a stall. */
  seek(on: boolean): void { this.seeking = on; }
  /** The element now plays another source (after a switch, or a new ticket): start over. */
  reset(): void { this.stalls = []; this.started = false; this.seeking = false; }
  /** Whether playback ran since the last reset (the start-up wait is over). */
  get hasStarted(): boolean { return this.started; }
  /** Recent stalls (for diagnostics). */
  get count(): number { return this.stalls.length; }

  /** `waiting` at time `now` (ms). True when this stall is the one that switches (once per watch). */
  stall(now: number): boolean {
    if (!this.started || this.seeking || this.switched) return false;
    this.stalls = this.stalls.filter((at) => now - at < this.windowMs);
    this.stalls.push(now);
    if (this.stalls.length >= this.needed) { this.switched = true; return true; }
    return false;
  }
}

/** A video's length as the poster shows it: "0:07", "12:34", "1:02:03". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A size as the line shows it: "820 KB", "7.5 MB", "1.2 GB". */
export function formatSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** The path a page reached its server by: loopback is this computer; the relay page is step 14 (not yet). */
export function pathOfPage(hostname: string): PathKind {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" ? "local" : "tailnet";
}
