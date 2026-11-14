// The chat frame's side of a line's media on the Botling 3 page (M2 steps 9 and 11). Bundled into chat.js after the 2.x
// chat page's entry (web-v3/chat-entry.ts), which it does not edit: it replaces the page's media source (Web/src/
// markdown.ts `setMediaSource`, set by the 2.x entry for the desktop's chat origin) with one that maps a line's local
// file to what the shell answered for it.
//
// - A file the shell has answered: its URL at once (the element loads it directly, so `<video>` does its own ranges).
// - A file not answered yet, or still `preparing`: a harmless `data:` placeholder source, the element hidden, and a
//   "<name> · preparing" box in its place (step 11: never a broken element), plus a `media.want` to the shell.
// - A video (step 11): the cached poster, a chip with the duration, size and badge ("preview", "original · may
//   buffer"); after a tap, 1 s without the first frame shows the path ("loading · via tailnet"); two stalls within
//   30 s switch a playing original to the preview at the same position, with a note (player.ts `StallWatch`); the
//   quality button cycles this device's choice (auto → original → preview).
// - A failed element (step 11): its source is dropped at once (no retry loop), the shell is told once and locates the
//   file again after a back-off; WebKit never fires `error` for a refused range of a playing element, so an element
//   that waits STALL_WATCHDOG_MS without a byte asks the shell to check instead.
// - A file that changed after its line (or is gone, or failed twice): the element is hidden and a short note says so.
// - Anything else (a web URL, a component card's picture) goes through the 2.x mapping as before.
// The line is the one the page names (Markdown media) or, for an attachment strip or the lightbox, the row's id.
import { localMediaSource } from "../src/contract/attachment-url";
import { setMediaSource } from "../../Web/src/markdown";
import { CHANGED_TEXT, FAILED_TEXT, GONE_TEXT, isLocalMedia, mediaKey, type FrameMediaMessage, type MediaAnswer, type ShellMediaMessage } from "./media-wire";
import { formatDuration, formatSize, PREPARING_TEXT, slowStart, StallWatch, SWITCH_NOTE, type Choice } from "./player";

const PLACEHOLDER = "data:,botling3-media-";
const MEDIA = "img, video, audio, source";
/** A playing or loading element that waits this long without a byte asks the shell to check the file. */
export const STALL_WATCHDOG_MS = 5_000;
/** After a tap, this long without the first frame shows the path's words. */
export const PATH_LABEL_AFTER_MS = 1_000;
/** Rate samples are sent when at least this much time passed (and only while the player still wants data). */
const RATE_WINDOW_MS = 1_000;
const WANTS_DATA_AHEAD_S = 20;

interface Pending { url: string; line?: string }

interface Playback {
  key: string;
  watch: StallWatch;
  watchdog: ReturnType<typeof setTimeout> | null;
  label: ReturnType<typeof setTimeout> | null;
  sample: { end: number; at: number; bytes: number; since: number } | null;
  /** From the tap until the first frame: when, how far it was buffered then, the check timer (slow-start rule). */
  start: { at: number; end: number; t: number; timer: ReturnType<typeof setInterval> } | null;
}

const answers = new Map<string, MediaAnswer>();
const placeholders: Pending[] = [];
const placeholderOf = new Map<string, string>();
const asked = new Set<string>();
const srcKey = new Map<string, string>();
/** How many answers the shell sent per key: an element that failed on one waits for the next before loading again. */
const gens = new Map<string, number>();
const playbacks = new WeakMap<HTMLMediaElement, Playback>();

function post(message: FrameMediaMessage): void {
  window.parent.postMessage(message, "*");
}

function shownBot(): string | undefined {
  return document.documentElement.dataset.chat?.split("/")[0];
}

function want(key: string, botId: string, line: string, url: string): void {
  if (asked.has(key)) return;
  asked.add(key);
  post({ botling3: "media.want", items: [{ key, botId, line, url }] });
}

function placeholder(url: string, line?: string): string {
  const id = `${line ?? ""}\n${url}`;
  let text = placeholderOf.get(id);
  if (!text) {
    text = `${PLACEHOLDER}${placeholders.length}`;
    placeholders.push({ url, ...(line ? { line } : {}) });
    placeholderOf.set(id, text);
  }
  return text;
}

/** The media source of the Botling 3 page. */
export function v3MediaSource(url: string, line?: string): string {
  if (!isLocalMedia(url)) return localMediaSource(document.documentElement.dataset.chat, url, line);
  // A local file before the page knows its chat (the first render after a reload): a placeholder all the same, resolved
  // when `data-chat` is set (never the raw file:// URL, which would show a broken element).
  const botId = shownBot();
  if (botId && line) {
    const key = mediaKey(botId, line, url);
    const known = answers.get(key);
    if (known?.state === "ready" && known.src) return known.src;
    want(key, botId, line, url);
  }
  return placeholder(url, line);
}

function nameOf(url: string): string {
  const path = url.replace(/^file:\/\//i, "").split(/[?#]/)[0] ?? "";
  try { return decodeURIComponent(path.split("/").pop() || "file"); } catch { return path.split("/").pop() || "file"; }
}

/** The key and the bot's URL of an element showing a placeholder or a URL the shell gave. */
function keyOf(element: Element): { key: string; url?: string } | null {
  const src = element.getAttribute("src") ?? "";
  if (src.startsWith(PLACEHOLDER)) {
    const pending = placeholders[Number(src.slice(PLACEHOLDER.length))];
    const botId = shownBot();
    if (!pending || !botId) return null;
    const line = pending.line ?? (element.closest(".row") as HTMLElement | null)?.dataset.id;
    if (!line) return null;
    const key = mediaKey(botId, line, pending.url);
    want(key, botId, line, pending.url);
    return { key, url: pending.url };
  }
  const key = srcKey.get(src) ?? (element as HTMLElement).dataset?.botling3Media ?? null;
  return key ? { key } : null;
}

const hostOf = (element: Element): HTMLElement => (element.tagName === "SOURCE" ? element.parentElement ?? element : element) as HTMLElement;

/** A sibling box of the element (before or after it), found by its role in our dataset. */
function sibling(host: HTMLElement, role: string, where: "before" | "after"): HTMLElement | null {
  let node = where === "before" ? host.previousElementSibling : host.nextElementSibling;
  while (node && (node as HTMLElement).dataset?.botling3Box) {
    if ((node as HTMLElement).dataset.botling3Box === role) return node as HTMLElement;
    node = where === "before" ? node.previousElementSibling : node.nextElementSibling;
  }
  return null;
}

function box(host: HTMLElement, role: string, where: "before" | "after", testid: string, css: string): HTMLElement {
  const found = sibling(host, role, where);
  if (found) return found;
  const div = document.createElement("div");
  div.dataset.botling3Box = role;
  div.dataset.testid = testid;
  div.style.cssText = css;
  if (where === "before") host.before(div); else host.after(div);
  return div;
}

function removeBox(host: HTMLElement, role: string, where: "before" | "after"): void { sibling(host, role, where)?.remove(); }

const NOTE_CSS = "padding:8px 10px;border-radius:8px;background:rgba(127,127,127,.14);font-size:13px;opacity:.85;margin:4px 0";
const WAIT_CSS = "display:flex;align-items:center;gap:8px;min-height:44px;max-width:360px;padding:10px 12px;border-radius:10px;background:rgba(127,127,127,.14);font-size:13px;margin:4px 0;overflow:hidden";

function hide(host: HTMLElement): void {
  if (host.dataset.botling3Hidden) return;
  host.dataset.botling3Hidden = "1";
  // `hidden` alone loses to the chat page's `.media { display: … }`.
  host.hidden = true;
  host.style.display = "none";
}

function unhide(host: HTMLElement): void {
  if (!host.dataset.botling3Hidden) return;
  delete host.dataset.botling3Hidden;
  host.hidden = false;
  host.style.removeProperty("display");
}

function note(element: Element, text: string, testid = "media-changed", role = "note"): void {
  const host = hostOf(element);
  const div = box(host, role, "after", testid, NOTE_CSS);
  div.dataset.testid = testid;
  div.setAttribute("role", "note");
  if (div.textContent !== text) div.textContent = text;
}

/** "<name> · preparing" in place of an element that has nothing to show yet. */
function waiting(element: Element, url: string | undefined, text: string, testid = "media-preparing"): void {
  const host = hostOf(element);
  hide(host);
  const div = box(host, "wait", "before", testid, WAIT_CSS);
  div.dataset.testid = testid;
  div.setAttribute("role", "status");
  const name = url ? nameOf(url) : host.getAttribute("aria-label") || host.getAttribute("alt") || "file";
  const shown = `${name} · ${text}`;
  if (div.textContent !== shown) div.textContent = shown;
}

function chip(video: HTMLVideoElement, answer: MediaAnswer): void {
  const parts = [answer.durationMs ? formatDuration(answer.durationMs) : "", answer.size ? formatSize(answer.size) : "", answer.badge ?? ""].filter(Boolean);
  if (!parts.length) { removeBox(video, "chip", "before"); return; }
  // A zero-height box before the video holds the chip over its top-left corner (the 2.x markup is not wrapped).
  const holder = box(video, "chip", "before", "media-chip-host", "position:relative;height:0;z-index:2;pointer-events:none");
  let span = holder.firstElementChild as HTMLElement | null;
  if (!span) {
    span = document.createElement("span");
    span.dataset.testid = "media-duration";
    span.style.cssText = "position:absolute;left:8px;top:8px;padding:2px 7px;border-radius:6px;background:rgba(0,0,0,.62);color:#fff;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap";
    holder.append(span);
  }
  const text = parts.join(" · ");
  if (span.textContent !== text) span.textContent = text;
  holder.style.visibility = video.dataset.botling3Played ? "hidden" : "visible";
}

const CHOICES: Choice[] = ["auto", "original", "preview"];

function quality(video: HTMLVideoElement, answer: MediaAnswer): void {
  if (!answer.sources?.preview) { removeBox(video, "quality", "after"); return; }
  const holder = box(video, "quality", "after", "media-quality-row", "display:flex;gap:6px;align-items:center;margin:2px 0 4px;font-size:12px;opacity:.8");
  let button = holder.querySelector("button");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.dataset.testid = "media-quality";
    button.style.cssText = "font:inherit;color:inherit;background:rgba(127,127,127,.16);border:0;border-radius:6px;padding:2px 8px;cursor:pointer";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const now = (button!.dataset.choice as Choice) || "auto";
      const next = CHOICES[(CHOICES.indexOf(now) + 1) % CHOICES.length]!;
      post({ botling3: "media.choice", choice: next });
    });
    holder.append(button);
  }
  const choice = answer.choice ?? "auto";
  button.dataset.choice = choice;
  const text = `Quality: ${choice}${choice === "auto" && answer.variant ? ` (${answer.variant})` : ""}`;
  if (button.textContent !== text) button.textContent = text;
}

/** Points a video at `src`, keeping its position and play state (a switch, a renewed ticket, a new choice). */
function retarget(video: HTMLVideoElement, src: string): void {
  const at = video.currentTime;
  const wasPlaying = !video.paused && !video.ended;
  const played = !!video.dataset.botling3Played;
  playbacks.get(video)?.watch.reset();
  video.setAttribute("src", src);
  if (!played && at === 0) return;
  video.addEventListener("loadedmetadata", () => {
    if (at > 0) { try { video.currentTime = at; } catch { /* not seekable yet */ } }
    if (wasPlaying) void video.play().catch(() => undefined);
  }, { once: true });
}

function playback(video: HTMLVideoElement, key: string): Playback {
  let state = playbacks.get(video);
  if (state && state.key === key) return state;
  state = { key, watch: new StallWatch(), watchdog: null, label: null, sample: null, start: null };
  playbacks.set(video, state);
  return state;
}

function apply(element: Element): void {
  const found = keyOf(element);
  if (!found) return;
  const { key } = found;
  const html = element as HTMLElement;
  const host = hostOf(element);
  const answer = answers.get(key);
  html.dataset.botling3Media = key;
  if (found.url) html.dataset.botling3Url = found.url;
  const url = html.dataset.botling3Url;
  if (!answer || answer.state === "preparing") {
    // Nothing to show yet: never a broken element.
    if ((element.getAttribute("src") ?? "").startsWith(PLACEHOLDER) || !answer) waiting(element, url, PREPARING_TEXT);
    return;
  }
  if (answer.state === "ready") {
    if (!answer.src) {
      // A file the element cannot show (a PDF without its page-1 thumbnail yet): a card with its name and size.
      waiting(element, url, [answer.kind === "pdf" ? "PDF" : "file", answer.size ? formatSize(answer.size) : ""].filter(Boolean).join(" · "), "media-card");
      return;
    }
    // This element failed on the answer it has: it waits (no retry loop) until the shell answers again.
    if (html.dataset.botling3FailedGen === String(gens.get(key) ?? 0)) return;
    delete html.dataset.botling3FailedGen;
    removeBox(host, "wait", "before");
    removeBox(host, "note", "after");
    unhide(host);
    if (element instanceof HTMLVideoElement) {
      playback(element, key);
      // The poster stands for the clip until it is played: no reading ahead of a video nobody started (WebKit would
      // otherwise fetch the whole file on a phone's connection).
      if (element.getAttribute("preload") !== "metadata" && !element.dataset.botling3Played) element.setAttribute("preload", "metadata");
      if (answer.poster && element.getAttribute("poster") !== answer.poster) element.setAttribute("poster", answer.poster);
      element.dataset.botling3Variant = answer.variant ?? "original";
      const current = element.getAttribute("src") ?? "";
      const known = Object.values(answer.sources ?? {}).some((source) => source?.src === current);
      // Keep a playing element on what it plays when that is still one of the file's URLs (the frame switched it).
      if (current !== answer.src && !(known && element.dataset.botling3Played && element.dataset.botling3Switched)) retarget(element, answer.src);
      chip(element, answer);
      quality(element, answer);
    } else if (element.getAttribute("src") !== answer.src) element.setAttribute("src", answer.src);
    return;
  }
  if (answer.state === "changed" || answer.state === "gone" || answer.state === "failed") {
    if (element.hasAttribute("src")) {
      element.removeAttribute("src");
      if (element instanceof HTMLMediaElement) element.load();
    }
    removeBox(host, "wait", "before");
    removeBox(host, "chip", "before");
    removeBox(host, "quality", "after");
    hide(host);
    note(element, answer.state === "changed" ? CHANGED_TEXT : answer.state === "gone" ? GONE_TEXT : FAILED_TEXT, answer.state === "failed" ? "media-failed" : "media-changed");
    return;
  }
  // `none`: the line names no indexed file; leave the 2.x element as the page made it, but not as a broken placeholder.
  if ((element.getAttribute("src") ?? "").startsWith(PLACEHOLDER)) waiting(element, url, "not available here", "media-none");
}

function scan(root: ParentNode = document): void {
  for (const element of root.querySelectorAll(MEDIA)) {
    const src = element.getAttribute("src") ?? "";
    if (src.startsWith(PLACEHOLDER) || srcKey.has(src) || (element as HTMLElement).dataset.botling3Media) apply(element);
  }
}

function onShell(event: MessageEvent): void {
  if (event.source !== window.parent) return;
  const data = event.data as ShellMediaMessage | null;
  if (!data || data.botling3 !== "media" || !Array.isArray(data.items)) return;
  for (const item of data.items) {
    if (typeof item?.key !== "string") continue;
    // An older URL of the key stays known: an element still showing it learns the new state.
    answers.set(item.key, item);
    gens.set(item.key, (gens.get(item.key) ?? 0) + 1);
    if (item.src) srcKey.set(item.src, item.key);
    for (const source of Object.values(item.sources ?? {})) if (source?.src) srcKey.set(source.src, item.key);
    // A state other than ready may change again (preparing → ready): the next render asks again.
    if (item.state !== "ready") asked.delete(item.key);
  }
  scan();
}

// --- Playback: path words, stalls, the switch, the watchdog, rate samples --------------------------------------------

function mediaOf(event: Event): { video: HTMLMediaElement; state: Playback; answer: MediaAnswer } | null {
  const video = event.target as HTMLMediaElement | null;
  if (!(video instanceof HTMLMediaElement)) return null;
  const key = video.dataset.botling3Media;
  if (!key) return null;
  const answer = answers.get(key);
  if (!answer || answer.state !== "ready") return null;
  const state = playbacks.get(video) ?? playback(video as HTMLVideoElement, key);
  return { video, state, answer };
}

function clearWatchdog(state: Playback): void { if (state.watchdog) { clearTimeout(state.watchdog); state.watchdog = null; } }
function clearLabel(video: HTMLMediaElement, state: Playback): void {
  if (state.label) { clearTimeout(state.label); state.label = null; }
  removeBox(video, "path", "after");
}

function armWatchdog(video: HTMLMediaElement, state: Playback): void {
  if (state.watchdog) return;
  state.watchdog = setTimeout(() => {
    state.watchdog = null;
    if (video.paused && !video.dataset.botling3Waiting) return;
    post({ botling3: "media.failed", key: state.key, reason: "stalled", src: video.getAttribute("src") ?? "" });
  }, STALL_WATCHDOG_MS);
}

function switchToPreview(video: HTMLVideoElement, state: Playback, answer: MediaAnswer, why: "stalls" | "slow-start"): void {
  const preview = answer.sources?.preview;
  if (!preview || video.dataset.botling3Variant !== "original") return;
  stopStart(state);
  video.dataset.botling3Switched = "1";
  video.dataset.botling3Variant = "preview";
  retarget(video, preview.src);
  state.watch.reset();
  note(video, SWITCH_NOTE, "media-switched", "switch");
  post({ botling3: "media.switched", key: state.key, why });
}

/** The media seconds buffered from the play position on. */
function bufferedAhead(video: HTMLMediaElement): number {
  const t = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= t + 0.25 && video.buffered.end(i) >= t) return video.buffered.end(i) - t;
  return 0;
}

function stopStart(state: Playback): void {
  if (state.start) { clearInterval(state.start.timer); state.start = null; }
}

/** The slow-start rule (player.ts): watched from a tap on an original that has a preview until its first frame. */
function watchStart(video: HTMLVideoElement, state: Playback, answer: MediaAnswer): void {
  stopStart(state);
  if (!answer.sources?.preview || video.dataset.botling3Variant !== "original") return;
  const start = { at: performance.now(), end: bufferedAhead(video), t: video.currentTime, timer: setInterval(() => {
    if (state.start !== start) return;
    // Over once the clock moves (not at `playing`: WebKit says `playing` and then holds the clock still while it
    // buffers to play through), or at `pause`.
    if (video.paused || video.currentTime > start.t + 0.25) { stopStart(state); return; }
    const current = answers.get(state.key) ?? answer;
    if (slowStart(performance.now() - start.at, bufferedAhead(video) - start.end)) switchToPreview(video, state, current, "slow-start");
  }, 500) };
  state.start = start;
}

/** Bytes that arrived while the player still wanted data, from how far the buffered range ahead grew. */
function sampleRate(video: HTMLMediaElement, state: Playback, answer: MediaAnswer): void {
  const variant = (video.dataset.botling3Variant ?? "original") as "original" | "preview";
  const bitrate = answer.sources?.[variant]?.bitrate;
  if (!bitrate) return;
  const t = video.currentTime;
  let end = -1;
  for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= t + 0.25 && video.buffered.end(i) >= t) end = video.buffered.end(i);
  const now = performance.now();
  if (end < 0) { state.sample = null; return; }
  const last = state.sample;
  if (!last || end < last.end || end - t > WANTS_DATA_AHEAD_S) { state.sample = { end, at: now, bytes: 0, since: now }; return; }
  last.bytes += ((end - last.end) * bitrate) / 8;
  last.end = end;
  last.at = now;
  if (now - last.since >= RATE_WINDOW_MS && last.bytes > 0) {
    post({ botling3: "media.rate", bytes: Math.round(last.bytes), ms: Math.round(now - last.since) });
    state.sample = { end, at: now, bytes: 0, since: now };
  }
}

function installPlayback(): void {
  const on = (type: string, fn: (event: Event) => void) => document.addEventListener(type, fn, true);
  on("play", (event) => {
    const found = mediaOf(event);
    if (!found) return;
    const { video, state, answer } = found;
    video.dataset.botling3Played = "1";
    removeBox(video, "chip", "before");
    if (video instanceof HTMLVideoElement && !state.watch.hasStarted) watchStart(video, state, answer);
    if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA && !state.label) {
      state.label = setTimeout(() => {
        state.label = null;
        if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !video.paused) return;
        const div = box(video, "path", "after", "media-path", "height:22px;line-height:22px;font-size:12px;opacity:.75;padding:0 2px;border-top:2px solid rgba(127,127,127,.45)");
        div.setAttribute("role", "status");
        div.textContent = answer.pathLabel ?? "loading";
      }, PATH_LABEL_AFTER_MS);
    }
  });
  on("playing", (event) => {
    const found = mediaOf(event);
    if (!found) return;
    delete found.video.dataset.botling3Waiting;
    found.state.watch.playing();
    clearLabel(found.video, found.state);
    clearWatchdog(found.state);
  });
  on("waiting", (event) => {
    const found = mediaOf(event);
    if (!found) return;
    const { video, state, answer } = found;
    video.dataset.botling3Waiting = "1";
    armWatchdog(video, state);
    if (state.watch.stall(Date.now()) && video instanceof HTMLVideoElement) switchToPreview(video, state, answer, "stalls");
  });
  on("stalled", (event) => { const found = mediaOf(event); if (found && !found.video.paused) armWatchdog(found.video, found.state); });
  on("seeking", (event) => { const found = mediaOf(event); if (found) found.state.watch.seek(true); });
  on("seeked", (event) => { const found = mediaOf(event); if (found) found.state.watch.seek(false); });
  on("pause", (event) => { const found = mediaOf(event); if (found) { clearLabel(found.video, found.state); clearWatchdog(found.state); stopStart(found.state); } });
  for (const type of ["progress", "timeupdate", "canplay"]) {
    on(type, (event) => {
      const found = mediaOf(event);
      if (!found) return;
      clearWatchdog(found.state);
      if (type !== "canplay") sampleRate(found.video, found.state, found.answer);
    });
  }
}

/** Installs the source and the watchers (once, after the 2.x chat page's entry ran). */
export function installChatMedia(): void {
  setMediaSource(v3MediaSource);
  window.addEventListener("message", onShell);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.target === document.documentElement) { scan(); continue; }
        if ((record.target as Element).matches?.(MEDIA)) apply(record.target as Element);
        continue;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(MEDIA)) apply(node);
        scan(node);
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "data-chat"] });
  // A media element that failed (a 410 for a file rewritten since, an expired ticket): drop its source at once (no
  // retry loop of the browser's own), show "preparing" in its place, and tell the shell once.
  document.addEventListener("error", (event) => {
    const element = event.target as Element | null;
    if (!element || !element.matches?.(MEDIA)) return;
    const src = element.getAttribute("src") ?? "";
    const key = srcKey.get(src);
    if (!key) return;
    (element as HTMLElement).dataset.botling3FailedGen = String(gens.get(key) ?? 0);
    element.removeAttribute("src");
    if (element instanceof HTMLMediaElement) element.load();
    waiting(element, (element as HTMLElement).dataset.botling3Url, "loading again…", "media-retry");
    post({ botling3: "media.failed", key, reason: "error", src });
  }, true);
  installPlayback();
  scan();
}
