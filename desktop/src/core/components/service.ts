// What every bot shares about components: the library, the command runs and their approvals, and
// the pictures a component's data names (served to its sandboxed frame by token, never by path).
// Plus the view the page draws of a component (`ChatPayload.display`).
import { cardData, PAGE_COMPONENT } from "../page-preview";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ComponentCommands, type CommandState } from "./commands";
import { ComponentLibrary, safeName } from "./library";
import type { Display } from "../reply";
import type { DisplayView } from "../../contract";

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", svg: "image/svg+xml", avif: "image/avif", ico: "image/x-icon",
};

/** A path a component's data names (`PagePreview.fileURL(from:)`): file: URLs, ~/…, absolute paths. */
function fileFrom(text: string): string | null {
  const value = text.trim();
  if (value.toLowerCase().startsWith("file:")) {
    try { return resolve(fileURLToPath(value)); } catch { return null; }
  }
  if (value.startsWith("~/")) return resolve(join(homedir(), value.slice(2)));
  if (!value.startsWith("/") && !/^[A-Za-z]:\\/.test(value)) return null;
  return resolve(value);
}

/** The pictures components' data name, each to the `botling-card://image/<token>` URL its frame loads (`ComponentImages`). */
export class ImageRegistry {
  private byToken = new Map<string, { path: string; type: string }>();

  urls(data: string): Record<string, string> {
    if (!data.includes("/")) return {};
    let value: unknown;
    try { value = JSON.parse(data); } catch { return {}; }
    const found: Record<string, string> = {};
    const visit = (item: unknown, depth: number) => {
      if (depth > 20) return;
      if (typeof item === "string") {
        if (found[item] || item.length >= 4096) return;
        const file = fileFrom(item);
        const type = file ? IMAGE_TYPES[extname(file).slice(1).toLowerCase()] : undefined;
        if (!file || !type) return;
        let real: string;
        let stamp: number;
        try { real = realpathSync(file); const stat = statSync(real); if (!stat.isFile()) return; stamp = stat.mtimeMs; } catch { return; }
        const token = createHash("sha256").update(`${real}\n${stamp}`).digest("hex").slice(0, 40);
        this.byToken.set(token, { path: real, type });
        if (this.byToken.size > 5_000) this.byToken.delete(this.byToken.keys().next().value!);
        found[item] = `botling-card://image/${token}`;
      } else if (Array.isArray(item)) {
        for (const entry of item) visit(entry, depth + 1);
      } else if (item && typeof item === "object") {
        for (const entry of Object.values(item)) visit(entry, depth + 1);
      }
    };
    visit(value, 0);
    return found;
  }

  /** Whether `url` (a file URL or path) is the picture this token stands for: a lightbox's buttons open only that file. */
  covers(token: string, url: string): boolean {
    const shown = this.byToken.get(token);
    const file = shown ? fileFrom(url) : null;
    if (!shown || !file) return false;
    try { return realpathSync(file) === shown.path; } catch { return false; }
  }

  /** Only a picture some component's data named. */
  file(token: string): { path: string; type: string } | null {
    return this.byToken.get(token) ?? null;
  }
}

export class ComponentsContext {
  readonly library: ComponentLibrary;
  readonly commands: ComponentCommands;
  readonly images = new ImageRegistry();

  constructor(readonly root: string, roots: () => string[], commands?: ComponentCommands) {
    this.library = new ComponentLibrary(roots);
    this.commands = commands ?? new ComponentCommands(join(root, "approved-commands.json"));
  }
}

/** What the page draws for one component (`ChatPayload.Display`), as the contract has it. */
export type DisplayData = DisplayView;

const clock = (ms: number | null) => (ms === null ? null : new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }));

/** The command a component in a bot's line takes its data from: its own, or about.md's when it was shown with no data. */
export function displayCommand(display: Display, role: string, library: ComponentLibrary): string | null {
  if (role !== "bot") return null;
  return display.command ?? (display.data === "null" ? library.command(display.name) : null);
}

/** A component in a message, with its command's run when its data comes from one (`ChatPayload.display(_:card:…)`). */
export function displayView(context: ComponentsContext, display: Display, card: string, role: string, folder: string): DisplayData {
  const { library, commands, images } = context;
  // The preview card's data gets what the app adds (`PagePreview.cardData`): where its frame loads the page from.
  const data = display.name === PAGE_COMPONENT ? cardData(display.data) : display.data;
  const urls = images.urls(data);
  const view: DisplayData = {
    name: display.name, data, at: typeof display.at === "number" ? display.at : null, command: null, folder: null, detail: null, card: null,
    status: null, error: null, ranAt: null, images: Object.keys(urls).length ? urls : null, every: null,
  };
  const detail = role === "bot" ? library.detailCommand(display.name) : null;
  if (detail) { view.detail = detail; view.card = card; view.folder = folder; }
  const command = displayCommand(display, role, library);
  if (!command) {
    // Nothing to draw: the page leaves it out; the bot hears why with the next message.
    if (display.data === "null") view.status = "empty";
    return view;
  }
  view.command = command;
  view.folder = folder;
  view.every = display.refresh ?? library.refreshInterval(display.name);
  const state: CommandState = commands.state(card, command, detail, folder);
  view.status = state.status;
  view.error = state.error;
  view.ranAt = clock(state.ranAt);
  if (state.data !== null) {
    view.data = state.data;
    const shown = images.urls(state.data);
    view.images = Object.keys(shown).length ? shown : null;
  }
  return view;
}

export { safeName };
