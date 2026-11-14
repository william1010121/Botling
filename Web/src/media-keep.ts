// A message row drawn again (more words streamed in, a reaction, a new stamp) keeps its videos and sounds as the very
// elements on screen: a new <video> for the same file would load and decode again (a third to half a second to its
// first frame) and, when it was playing, start over at 0:00 paused. Each one in the new row is matched with the old
// row's of the same kind and source, in order; anything else in the row is the new drawing.

type Media = HTMLVideoElement | HTMLAudioElement;
type MovingParent = ParentNode & { moveBefore?: (node: Node, child: Node | null) => void };
type Pair = { kept: Media; placeholder: Media; playing: boolean };

const keyOf = (media: Element): string | null => {
  const src = media.getAttribute("src");
  return src ? `${media.tagName}\n${src}` : null;
};

/** Pairs the new row's media with the old row's that show the same source (each old one used once, in order). */
export function mediaPairs(old: Element, fresh: Element): Array<[kept: Media, placeholder: Media]> {
  const waiting = new Map<string, Media[]>();
  for (const media of old.querySelectorAll<Media>("video, audio")) {
    const key = keyOf(media);
    if (!key) continue;
    const list = waiting.get(key) ?? [];
    list.push(media);
    waiting.set(key, list);
  }
  if (!waiting.size) return [];
  const pairs: Array<[Media, Media]> = [];
  for (const media of fresh.querySelectorAll<Media>("video, audio")) {
    const key = keyOf(media);
    const kept = key ? waiting.get(key)?.shift() : undefined;
    if (kept) pairs.push([kept, media]);
  }
  return pairs;
}

/**
 * Puts `kept` where `placeholder` stands, with `placeholder`'s attributes (not its source, which is `kept`'s). An atomic
 * move (`moveBefore`, both in the page) keeps it playing; otherwise one that was playing is played again after the move.
 */
function standIn({ kept, placeholder, playing }: Pair): void {
  for (const { name } of [...kept.attributes]) {
    if (name !== "src" && !placeholder.hasAttribute(name)) kept.removeAttribute(name);
  }
  for (const { name, value } of [...placeholder.attributes]) {
    if (name !== "src" && name !== "preload" && kept.getAttribute(name) !== value) kept.setAttribute(name, value);
  }
  const parent = placeholder.parentNode as MovingParent | null;
  if (!parent) return;
  let moved = false;
  if (typeof parent.moveBefore === "function" && kept.isConnected && (parent as unknown as Node).isConnected) {
    try { parent.moveBefore(kept, placeholder); moved = true; } catch { /* not an atomic move here: below */ }
  }
  if (!moved) {
    parent.insertBefore(kept, placeholder);
    if (playing) void Promise.resolve().then(() => kept.play()).catch(() => undefined);
  }
  placeholder.remove();
}

/**
 * Brings the drawn row `old` up to its redraw `fresh` and returns the row now on screen. `keepFrames` (components.ts)
 * either patches `old` in place, keeping its component frames, and returns it, or returns `fresh`, which then takes
 * `old`'s place. Either way the videos and sounds `fresh` shows with the same source as `old` stay `old`'s very
 * elements (where they now sit, with `fresh`'s attributes), so they neither load again nor stop.
 */
export function redrawKeepingMedia(old: HTMLElement, fresh: HTMLElement,
  keepFrames: (old: HTMLElement, fresh: HTMLElement) => HTMLElement): HTMLElement {
  const pairs: Pair[] = mediaPairs(old, fresh).map(([kept, placeholder]) => ({ kept, placeholder, playing: !kept.paused && !kept.ended }));
  // The new copies stand in only for their place: they load nothing (their load starts only after this task).
  for (const { placeholder } of pairs) { placeholder.removeAttribute("src"); placeholder.preload = "none"; }
  const shown = keepFrames(old, fresh);
  if (shown !== fresh) {
    // `old` patched in place: its media went out with the parts `fresh` replaced; each goes back where its copy sits.
    for (const pair of pairs) if (old.contains(pair.placeholder)) standIn(pair);
    return shown;
  }
  if (!pairs.length) { old.replaceWith(fresh); return fresh; }
  // Both rows in the page for a moment, so each kept element moves within the page (an atomic move keeps it playing).
  if (old.parentNode) old.before(fresh);
  for (const pair of pairs) standIn(pair);
  old.remove();
  return fresh;
}

/** Puts `fresh` in `old`'s place, keeping the videos and sounds of the same source as `old`'s very elements. */
export function swapKeepingMedia(old: HTMLElement, fresh: HTMLElement): void {
  redrawKeepingMedia(old, fresh, (_old, next) => next);
}
