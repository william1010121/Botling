// The 「網頁預覽卡片」 component (1.x's PagePreview.swift): a one-page HTML result shown in the chat as a
// small live preview, with its title and a button to open it full-size. A reply's links to result pages
// (`[name](file://…/artifacts/x.html)`) are drawn as these cards under it, and a `<show name="網頁預覽卡片">`
// card gets the same data. The card's sandboxed frame cannot open `file:` URLs, so main serves a page to it
// from `botling-card://preview/<path>` — only files inside a folder called `artifacts` (pictures beside a
// page load too), checked again by main through symlinks (src/main/main.ts).
//
// 2.0 differences: no pictures of the pages (1.x's PageShots): a card always runs its page in a frame; and a
// page named by a `<show>` card outside an `artifacts` folder is not served (1.x serves that one file).
import { statSync } from "node:fs";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { filePath, isArtifactPage, pageInCard, PAGE_COMPONENT } from "./specs";
import { previewURL } from "./preview-url";

export { PREVIEW_ORIGIN, previewFile, previewURL } from "./preview-url";

export { PAGE_COMPONENT };
/** At most this many pages are previewed under one message (`perMessage`). */
const PER_MESSAGE = 3;

/** A path from what a bot wrote: `/abs/path`, `~/path` or a `file://` URL. */
export const pagePath = filePath;

const sorted = (object: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

/**
 * The data the card's template reads (`cardData`): what the bot gave (`path`, `title`), with what the app
 * adds: `src` (to load the preview from), `url` (to open it full-size), `name` (the file name) and
 * `missing` (no such page). Keys sorted, as 1.x's JSONSerialization writes them.
 */
export function cardData(data: string): string {
  let object: Record<string, unknown>;
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return data;
    object = parsed as Record<string, unknown>;
  } catch {
    return data;
  }
  const given = typeof object.path === "string" ? object.path : typeof object.url === "string" ? object.url : "";
  const file = filePath(given);
  if (!file) {
    object.missing = true;
    return sorted(object);
  }
  let stat: ReturnType<typeof statSync> | null = null;
  try { stat = statSync(file); } catch { stat = null; }
  const exists = !!stat?.isFile();
  object.path = file;
  object.url = pathToFileURL(file).href;
  object.name = basename(file);
  delete object.shot;
  if (exists && /^\.html?$/i.test(extname(file)) && isArtifactPage(file)) object.src = previewURL(file, Math.trunc(stat!.mtimeMs / 1000));
  else delete object.src;
  object.missing = !exists;
  if (typeof object.title !== "string" || !object.title.trim()) object.title = basename(file, extname(file));
  return sorted(object);
}

/**
 * Cards for the result pages a message links to, `[name](file://…/artifacts/x.html)`, that are there on disk:
 * at most three, each page once, none for `skipping` (pages its `<show>` cards show already) (`linkedCards`).
 */
export function linkedCards(text: string, skipping: string[] = []): string[] {
  const seen = new Set(skipping);
  const cards: string[] = [];
  // RichText's link pattern: [label](target), the label on one line.
  for (const match of text.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
    if (cards.length >= PER_MESSAGE) break;
    if (!match[2]!.toLowerCase().startsWith("file:")) continue;
    const file = filePath(match[2]!);
    if (!file || !isArtifactPage(file) || seen.has(file)) continue;
    try { if (!statSync(file).isFile()) continue; } catch { continue; }
    seen.add(file);
    cards.push(cardData(JSON.stringify({ path: file, title: match[1]!.trim() })));
  }
  return cards;
}

/** The preview cards under a bot's line or a notice, when the card component is there (`ChatPayload.previews`). */
export function previewCards(record: { role: string; text: string; displays?: unknown[] }, hasComponent: boolean): string[] | null {
  if ((record.role !== "bot" && record.role !== "notice") || !hasComponent || !record.text.includes("](file:")) return null;
  const shown = ((record.displays ?? []) as { name?: unknown; data?: unknown }[]).flatMap((display) => (display.name === PAGE_COMPONENT && typeof display.data === "string" ? pageInCard(display.data) ?? [] : []));
  const cards = linkedCards(record.text, shown);
  return cards.length ? cards : null;
}

/** The page a preview card's data names (`PagePreview.page(inCard:)`). */
export const pageOfCard = pageInCard;
