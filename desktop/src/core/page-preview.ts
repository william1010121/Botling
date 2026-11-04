// The 「網頁預覽卡片」 component (1.x's PagePreview.swift): a one-page HTML result shown in the chat as a
// small live preview, with its title and a button to open it full-size. A reply's links to result pages
// (`[name](file://…/artifacts/x.html)`) are drawn as these cards under it, and a `<show name="網頁預覽卡片">`
// card gets the same data. The card's sandboxed frame cannot open `file:` URLs, so main serves a page to it
// from `botling-card://preview/<path>` — only files inside a folder called `artifacts` (pictures beside a
// page load too), checked again by main through symlinks (src/main/main.ts).
//
// A Markdown result (`artifacts/x.md`, long text still being discussed) gets the same card: main renders it as the chat
// does (src/main/markdown-page.ts), and its title is its first `# heading`.
//
// 2.0 differences: no pictures of the pages (1.x's PageShots): a card always runs its page in a frame; and a
// page named by a `<show>` card outside an `artifacts` folder is not served (1.x serves that one file).
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { markdownTitle, PAGE_COMPONENT, previewURL } from "./preview-url";

export { markdownTitle, PREVIEW_ORIGIN, previewFile, previewURL } from "./preview-url";

export { PAGE_COMPONENT };
/** At most this many pages are previewed under one message (`perMessage`). */
const PER_MESSAGE = 3;

/** A path from what a bot wrote: `/abs/path`, `~/path` or a `file://` URL (`PagePreview.fileURL(from:)`). */
export function filePath(text: string): string | null {
  const value = text.trim();
  if (value.toLowerCase().startsWith("file:")) { try { return resolve(fileURLToPath(value)); } catch { return null; } }
  if (value.startsWith("~/")) return resolve(process.env.HOME ?? "/", value.slice(2));
  return value.startsWith("/") ? resolve(value) : null;
}

const inArtifacts = (path: string) => {
  for (let folder = dirname(path); folder !== "/" && folder; folder = dirname(folder)) if (basename(folder) === "artifacts") return true;
  return false;
};

/** A result page: an .html file in an `artifacts` folder (`PagePreview.isArtifactPage`). */
export function isArtifactPage(path: string): boolean {
  return /\.html?$/i.test(path) && inArtifacts(path);
}

/** A Markdown result: an .md file in an `artifacts` folder. */
export function isArtifactMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path) && inArtifacts(path);
}

/** A result a preview card shows: a page or a Markdown file in an `artifacts` folder. */
export function isArtifactResult(path: string): boolean {
  return isArtifactPage(path) || isArtifactMarkdown(path);
}

function fileTitle(file: string): string | null {
  try { return markdownTitle(readFileSync(file, "utf8").slice(0, 65536)); } catch { return null; }
}

/** The page a preview card's data names (`PagePreview.page(inCard:)`). */
export function pageInCard(data: string): string | null {
  try {
    const object = JSON.parse(data) as Record<string, unknown>;
    const given = typeof object.path === "string" ? object.path : typeof object.url === "string" ? object.url : null;
    return given ? filePath(given) : null;
  } catch {
    return null;
  }
}

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
  if (exists && isArtifactResult(file)) object.src = previewURL(file, Math.trunc(stat!.mtimeMs / 1000));
  else delete object.src;
  object.missing = !exists;
  // A Markdown result is titled by its first `# heading`.
  const heading = exists && isArtifactMarkdown(file) ? fileTitle(file) : null;
  if (heading) object.title = heading;
  else if (typeof object.title !== "string" || !object.title.trim()) object.title = basename(file, extname(file));
  return sorted(object);
}

/**
 * Cards for the result pages a message links to, `[name](file://…/artifacts/x.html)` or `x.md`, that are there on disk:
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
    if (!file || !isArtifactResult(file) || seen.has(file)) continue;
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
