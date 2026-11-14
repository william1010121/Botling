// The video player over the page on the relay path (M2 step 14). The chat frame is sandboxed with an opaque origin, which
// no service worker controls (the step 9 spike), so a line's video cannot reach the content bridge from there. On the
// relay path the frame shows the poster with the duration and size, and a tap opens this player in the page itself,
// where the worker answers the `<video>`'s range requests over the session (sw.ts).
//
// The player keeps the step 11 rules (player.ts), as the chat frame applies them on the tailnet path:
//   - two stalls within 30 s of a playing original switch it to the preview at the same position, with the note;
//   - slow start (WebKit holds the start of a clip it cannot play through): a tapped original whose clock has not moved
//     after 4 s while its buffer grew slower than 1.5 × real time switches too;
//   - after 1 s without the first frame, the path's words ("loading · via relay");
//   - an element that waits 5 s without a byte asks the shell to check the file (WebKit never fires `error` on a refused
//     range); an `error` asks the shell to locate the file again;
//   - rate samples (buffered growth × bitrate) feed the session's meter.
// ✕ or Escape closes it (the element's source is dropped, which cancels its reads).
import { slowStart, StallWatch, SWITCH_NOTE, type VariantName } from "../player";

export interface VideoOpen {
  key: string;
  name: string;
  src: string;
  variant: VariantName;
  sources: Partial<Record<VariantName, { src: string; bitrate?: number }>>;
  poster?: string;
  pathLabel?: string;
}

export interface VideoHooks {
  rate(bytes: number, ms: number): void;
  switched(key: string, why: "stalls" | "slow-start"): void;
  failed(key: string, reason: "error" | "stalled", src: string): void;
}

export interface VideoDiagnostics {
  opened: number;
  key?: string;
  variant?: VariantName;
  /** ms from opening to the first frame on screen (the clock moved, or `loadeddata` + `playing`). */
  firstFrameMs?: number;
  /** Each seek: where to, and ms to `seeked`. */
  seeks: Array<{ to: number; ms: number }>;
  switches: string[];
  errors: number;
}

export const newVideoDiagnostics = (): VideoDiagnostics => ({ opened: 0, seeks: [], switches: [], errors: 0 });

export const STALL_WATCHDOG_MS = 5_000;
export const PATH_LABEL_AFTER_MS = 1_000;
const RATE_WINDOW_MS = 1_000;
const WANTS_DATA_AHEAD_S = 20;

let shown: { root: HTMLElement; off: () => void } | null = null;

export function closeVideoPlayer(): void {
  if (!shown) return;
  shown.off();
  const video = shown.root.querySelector("video");
  if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
  shown.root.remove();
  shown = null;
}

/** The media seconds buffered from the play position on. */
function bufferedAhead(video: HTMLMediaElement): number {
  const t = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= t + 0.25 && video.buffered.end(i) >= t) return video.buffered.end(i) - t;
  return 0;
}

export function openVideoPlayer(open: VideoOpen, hooks: VideoHooks, diag: VideoDiagnostics = newVideoDiagnostics()): HTMLVideoElement {
  closeVideoPlayer();
  const t0 = performance.now();
  diag.opened += 1;
  diag.key = open.key;
  diag.variant = open.variant;
  delete diag.firstFrameMs;
  diag.seeks = [];
  const root = document.createElement("div");
  root.className = "v3-video";
  root.dataset.testid = "video-player";
  root.dataset.key = open.key;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", open.name);
  const bar = document.createElement("header");
  bar.className = "v3-video-bar";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "v3-video-close";
  close.setAttribute("aria-label", "Close");
  close.title = "Close";
  close.textContent = "✕";
  const title = document.createElement("div");
  title.className = "v3-video-title";
  title.textContent = open.name;
  bar.append(close, title);
  const stage = document.createElement("div");
  stage.className = "v3-video-stage";
  const video = document.createElement("video");
  video.controls = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.preload = "auto";
  if (open.poster) video.poster = open.poster;
  video.dataset.botling3Variant = open.variant;
  stage.append(video);
  const status = document.createElement("div");
  status.className = "v3-video-status";
  status.setAttribute("role", "status");
  status.dataset.testid = "video-status";
  root.append(bar, stage, status);

  const watch = new StallWatch();
  let variant: VariantName = open.variant;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let label: ReturnType<typeof setTimeout> | null = null;
  let start: { at: number; end: number; t: number; timer: ReturnType<typeof setInterval> } | null = null;
  let sample: { end: number; bytes: number; since: number } | null = null;
  let seekFrom: { to: number; at: number } | null = null;
  let switched = false;

  const say = (text: string) => { if (status.textContent !== text) status.textContent = text; };
  const clearWatchdog = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };
  const clearLabel = () => { if (label) { clearTimeout(label); label = null; } if (status.dataset.kind === "path") { say(""); delete status.dataset.kind; } };
  const stopStart = () => { if (start) { clearInterval(start.timer); start = null; } };
  const armWatchdog = () => {
    if (watchdog) return;
    watchdog = setTimeout(() => { watchdog = null; if (!video.paused) hooks.failed(open.key, "stalled", video.getAttribute("src") ?? ""); }, STALL_WATCHDOG_MS);
  };
  const firstFrame = () => { if (diag.firstFrameMs === undefined) diag.firstFrameMs = Math.round(performance.now() - t0); };

  const retarget = (src: string) => {
    const at = video.currentTime;
    const playing = !video.paused && !video.ended;
    watch.reset();
    video.src = src;
    video.addEventListener("loadedmetadata", () => {
      if (at > 0) { try { video.currentTime = at; } catch { /* not seekable yet */ } }
      if (playing) void video.play().catch(() => undefined);
    }, { once: true });
  };
  const toPreview = (why: "stalls" | "slow-start") => {
    const preview = open.sources.preview;
    if (!preview || variant !== "original" || switched) return;
    switched = true;
    stopStart();
    variant = "preview";
    video.dataset.botling3Variant = "preview";
    diag.variant = "preview";
    diag.switches.push(why);
    retarget(preview.src);
    status.dataset.kind = "switch";
    say(SWITCH_NOTE);
    hooks.switched(open.key, why);
  };
  const watchStart = () => {
    stopStart();
    if (!open.sources.preview || variant !== "original") return;
    const s = { at: performance.now(), end: bufferedAhead(video), t: video.currentTime, timer: setInterval(() => {
      if (start !== s) return;
      if (video.paused || video.currentTime > s.t + 0.25) { stopStart(); return; }
      if (slowStart(performance.now() - s.at, bufferedAhead(video) - s.end)) toPreview("slow-start");
    }, 500) };
    start = s;
  };
  const sampleRate = () => {
    const bitrate = open.sources[variant]?.bitrate;
    if (!bitrate) return;
    const t = video.currentTime;
    let end = -1;
    for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= t + 0.25 && video.buffered.end(i) >= t) end = video.buffered.end(i);
    const now = performance.now();
    if (end < 0) { sample = null; return; }
    if (!sample || end < sample.end || end - t > WANTS_DATA_AHEAD_S) { sample = { end, bytes: 0, since: now }; return; }
    sample.bytes += ((end - sample.end) * bitrate) / 8;
    sample.end = end;
    if (now - sample.since >= RATE_WINDOW_MS && sample.bytes > 0) {
      hooks.rate(Math.round(sample.bytes), Math.round(now - sample.since));
      sample = { end, bytes: 0, since: now };
    }
  };

  const on = (type: string, fn: () => void) => video.addEventListener(type, fn);
  on("play", () => {
    if (!watch.hasStarted) watchStart();
    if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA && !label) {
      label = setTimeout(() => {
        label = null;
        if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !video.paused) return;
        status.dataset.kind = "path";
        say(open.pathLabel ?? "loading");
      }, PATH_LABEL_AFTER_MS);
    }
  });
  on("playing", () => { watch.playing(); clearLabel(); clearWatchdog(); });
  on("waiting", () => { armWatchdog(); if (watch.stall(Date.now())) toPreview("stalls"); });
  on("stalled", () => { if (!video.paused) armWatchdog(); });
  on("seeking", () => { watch.seek(true); seekFrom = { to: video.currentTime, at: performance.now() }; });
  on("seeked", () => {
    watch.seek(false);
    if (seekFrom) { diag.seeks.push({ to: Number(seekFrom.to.toFixed(2)), ms: Math.round(performance.now() - seekFrom.at) }); seekFrom = null; }
  });
  on("pause", () => { clearLabel(); clearWatchdog(); stopStart(); });
  on("timeupdate", () => { if (video.currentTime > 0 && !video.paused) firstFrame(); clearWatchdog(); sampleRate(); });
  on("progress", () => { clearWatchdog(); sampleRate(); });
  on("canplay", clearWatchdog);
  on("error", () => {
    diag.errors += 1;
    const src = video.getAttribute("src") ?? "";
    if (!src) return;
    video.removeAttribute("src");
    video.load();
    say("loading again…");
    hooks.failed(open.key, "error", src);
  });
  const vfc = (video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
  if (vfc) vfc.call(video, () => firstFrame());

  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeVideoPlayer(); };
  close.addEventListener("click", () => closeVideoPlayer());
  window.addEventListener("keydown", onKey);
  document.body.append(root);
  shown = { root, off: () => { window.removeEventListener("keydown", onKey); clearWatchdog(); clearLabel(); stopStart(); } };
  video.src = open.src;
  void video.play().catch(() => undefined);
  close.focus({ preventScroll: true });
  return video;
}

/** The player's element for `key` while it is open (the shell points it at a new URL after a re-locate). */
export function openVideoElement(key: string): HTMLVideoElement | null {
  return shown && shown.root.dataset.key === key ? shown.root.querySelector("video") : null;
}
