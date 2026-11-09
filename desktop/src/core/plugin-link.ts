// A link a plugin frame asks the app to open (`ccb.openLink`, the Note tab's links, 2026-11-10): what it names, decided by
// the core alone. The plugin gives the href as the note has it; the core says whether it is a web link (the default
// browser) or a local file, and which one. Main then opens it as it opens a chat link (main.ts `openPluginLink`).
//
// - http:, https:, mailto:      a web link (opened in the default browser, as the user's own click on a chat link).
// - file: URLs, /abs, ~/…      a local file.
// - anything else with a scheme  refused (javascript:, data:, botling-*:, vscode:, …).
// - a relative path              against the note's own folder (where `note-assets/…` links point), `#…`/`?…` dropped.
//
// A local file is opened only when it is inside the bot's folder or the note's folder (symlinks resolved), or when the
// saved note links exactly that href: a plugin cannot open any file it likes, as a component cannot in the chat.
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type PluginLinkTarget = { kind: "web"; url: string } | { kind: "file"; path: string };

export interface PluginLinkPlace {
  /** The folder the note is in: relative links resolve here. */
  noteDir: string;
  /** The bot's working folder (null: none known). */
  botFolder: string | null;
  /** The user's home folder, for `~/…`. */
  home: string;
  /** The saved note's text: a file it links exactly (by this href) may be opened wherever it is. */
  noteText: string;
}

const WEB = /^(https?|mailto):/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function refused(message: string): Error {
  return Object.assign(new Error(message), { code: "forbidden" });
}

/** The path a local href names (null: not a local href); `#…` and `?…` are not part of a path. */
function localPath(href: string, place: PluginLinkPlace): string | null {
  if (/^file:/i.test(href)) {
    try { return fileURLToPath(href.replace(/[?#].*$/, "")); } catch { return null; }
  }
  if (SCHEME.test(href) || href.startsWith("//")) return null;
  const bare = href.replace(/[?#].*$/, "");
  if (!bare) return null;
  let path: string;
  try { path = decodeURIComponent(bare); } catch { path = bare; }
  if (path === "~" || path.startsWith("~/")) return join(place.home, path.slice(1));
  return isAbsolute(path) ? resolve(path) : resolve(place.noteDir, path);
}

function real(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function inside(path: string, folder: string): boolean {
  const way = relative(real(folder), path);
  return way === "" || (!!way && !way.startsWith(`..${sep}`) && way !== ".." && !isAbsolute(way));
}

/** What `href` (as the note has it) opens; throws `forbidden` for a scheme or a file the app does not open for a plugin. */
export function pluginLinkTarget(href: string, place: PluginLinkPlace): PluginLinkTarget {
  const link = href.trim();
  if (!link) throw refused("An empty link opens nothing.");
  if (link.startsWith("#")) throw refused("A link inside the page opens nothing in the app.");
  if (WEB.test(link)) {
    let url: URL;
    try { url = new URL(link); } catch { throw refused("That web link is not a URL."); }
    if (url.protocol !== "mailto:" && !url.hostname) throw refused("That web link has no host.");
    return { kind: "web", url: url.href };
  }
  const path = localPath(link, place);
  if (path === null) throw refused(`Links of that kind (${(SCHEME.exec(link)?.[0] ?? link.slice(0, 2))}) are not opened.`);
  const file = real(path);
  const allowed = inside(file, place.noteDir) || (place.botFolder !== null && inside(file, place.botFolder)) || linkedByNote(link, place.noteText);
  if (!allowed) throw refused("That file is outside the bot's folder and the note does not link it.");
  return { kind: "file", path: file };
}

/** The saved note links exactly `href` (in a Markdown link or picture, or as an autolink). */
function linkedByNote(href: string, text: string): boolean {
  if (!text) return false;
  return text.includes(`](${href})`) || text.includes(`](<${href}>)`) || text.includes(`<${href}>`) || text.includes(`](${href} `);
}

/** How main opens a target: the default browser, the app's Markdown report preview, or as a chat link opens a file (its app, or Finder). */
export function pluginLinkRoute(target: PluginLinkTarget): "browser" | "markdown" | "file" {
  if (target.kind === "web") return "browser";
  return /\.(md|markdown)$/i.test(target.path) ? "markdown" : "file";
}
