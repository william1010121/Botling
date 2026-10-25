// The component library (the Swift app's ComponentLibrary): the parts of the chat that are HTML
// templates instead of fixed code, one folder each holding `template.html` and `about.md` (what
// data it takes and how a bot uses it). In 2.0 they live in the data folder's plugin library,
// `<core>/plugins/ccb-components/components/<name>/` first, then any other plugin's
// `components/` folder — the first launch imports 1.x's (store/importer.ts, read-only). A change
// on disk (a template edited by hand) is picked up by `rescan`, and the page draws it anew.
//
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** At most this many components per bot (its own list); the library itself has no cap. */
export const COMPONENT_LIMIT = 20;
/** The app's own cards (1.x's built-ins): every bot has them from the start. */
export const BUILT_INS = ["choices", "網頁預覽卡片"];
export const LIVE_RANGE = { min: 1, max: 3600 };

/** Seconds from "2s", "every 2s", "1.5s", "5 seconds", "3", "1m", "500ms" (raised to a second); null for anything else or past an hour (`ComponentRefresh.seconds`). */
export function refreshSeconds(text: string): number | null {
  let value = text.replace(/^[` ]+|[` ]+$/g, "").toLowerCase();
  if (value.startsWith("every ")) value = value.slice(6).trim();
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  if (!(number > 0)) return null;
  const unit = ["", "s", "sec", "secs", "second", "seconds"].includes(match[2]!) ? 1
    : ["ms", "millisecond", "milliseconds"].includes(match[2]!) ? 0.001
    : ["m", "min", "mins", "minute", "minutes"].includes(match[2]!) ? 60 : null;
  if (unit === null) return null;
  const seconds = number * unit;
  if (seconds > LIVE_RANGE.max) return null;
  return Math.max(seconds, LIVE_RANGE.min);
}

/** The text after `label` on the first about.md line starting with it (a list item too), without backticks. */
export function aboutLine(about: string, label: string): string | null {
  for (const raw of about.split("\n")) {
    let text = raw.trim();
    if (text.startsWith("- ") || text.startsWith("* ")) text = text.slice(2);
    if (!text.toLowerCase().startsWith(label)) continue;
    const value = text.slice(label.length).trim().replace(/^`+|`+$/g, "").trim();
    if (value) return value;
  }
  return null;
}

/** A Board size as about.md or pins.json spells it ("3x2", "2×1", a name, S/M/L); null otherwise (`PinnedComponent.Size(spelled:)`). */
export function spelledSize(text: string): string | null {
  const value = text.trim().toLowerCase().replaceAll("×", "x").replaceAll(" ", "");
  if (value === "s") return "1x1";
  if (value === "m") return "2x2";
  if (value === "l") return "4x2";
  const named: Record<string, string> = { small: "1x1", wide: "2x1", tall: "1x2", large: "2x2", xlarge: "4x2" };
  if (named[value]) return named[value]!;
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) return null;
  const [w, h] = [Number(match[1]), Number(match[2])];
  return w >= 1 && w <= 4 && h >= 1 && h <= 4 ? `${w}x${h}` : null;
}

/** The sizes an about.md `Sizes:` line hints at (2×2 alone without one). */
export function aboutSizes(about: string): string[] {
  const sizes: string[] = [];
  for (const part of (aboutLine(about, "sizes:") ?? "").split(/[,，、]/)) {
    const text = part.replace(/^[` ]+|[` ]+$/g, "");
    const size = text.length > 1 ? spelledSize(text) : null;
    if (size && !sizes.includes(size)) sizes.push(size);
  }
  return sizes.length ? sizes : ["2x2"];
}

const isSymbolName = (text: string) => !!text && text.length <= 64 && text.split(".").every((part) => /^[a-z0-9]+$/.test(part));
const isEmoji = (text: string) => !!text && [...new Intl.Segmenter().segment(text)].length <= 2 && !/[\x00-\x7f]/.test(text);

/** A component name as a folder name (`ComponentLibrary.safeName`). */
export function safeName(name: string): string {
  return [...name.toLowerCase()].map((c) => (/[\p{L}\p{N}-]/u.test(c) ? c : "-")).join("").replace(/^-+|-+$/g, "");
}

/** The plugin library's git, as the library asks it about earlier versions (`PluginLibraryGit`). */
export interface HistoryGit {
  readonly folder: string;
  hasPrevious(path: string): boolean;
  revert(path: string, label: string): string | null;
}

export interface ComponentInfoData {
  template: string;
  version: number;
  updated: boolean;
  /** Maintainer is changing it now. */
  working: boolean;
  /** There is an earlier version in git to go back to. */
  hasPrevious: boolean;
  sizes: string[];
  icon: string | null;
  title: string | null;
}

export class ComponentLibrary {
  names: string[] = [];
  private modified = new Map<string, number>();
  private aboutModified = new Map<string, number>();
  private versions = new Map<string, number>();
  private updated = new Set<string>();
  /** Components being changed now, with what was asked (`working`). */
  private working = new Map<string, string>();
  /** Whether git has an earlier version of each, asked once per change (`previous`). */
  private previous = new Map<string, boolean>();
  /** The plugin library's git, for earlier versions; null when there is none. */
  git: HistoryGit | null = null;
  /** Bumps whenever a template or about.md changes (for views to redraw). */
  stamp = 0;

  /** `roots()`: the component folders, the library's own first. */
  constructor(private roots: () => string[]) {
    this.rescan();
  }

  /** The folder that has `name` (the first root that does). */
  private home(name: string): string {
    for (const root of this.roots()) if (existsSync(join(root, name, "template.html"))) return root;
    return this.roots()[0] ?? "";
  }

  private read(name: string, file: "template.html" | "about.md"): string | null {
    if (!this.names.includes(name)) return null;
    try { return readFileSync(join(this.home(name), name, file), "utf8"); } catch { return null; }
  }

  template(name: string): string | null { return this.read(name, "template.html"); }
  about(name: string): string { return this.read(name, "about.md") ?? ""; }

  /** The folder a component's files are in (for its Command's scripts). */
  folder(name: string): string { return join(this.home(name), name); }

  command(name: string): string | null { return aboutLine(this.about(name), "command:"); }
  boardCommand(name: string): string | null { return aboutLine(this.about(name), "board command:"); }
  detailCommand(name: string): string | null { return aboutLine(this.about(name), "detail command:"); }
  refreshInterval(name: string): number | null { const line = aboutLine(this.about(name), "refresh:"); return line ? refreshSeconds(line) : null; }
  sizes(name: string): string[] { return aboutSizes(this.about(name)); }
  icon(name: string): string | null { const icon = aboutLine(this.about(name), "icon:"); return icon && (isSymbolName(icon) || isEmoji(icon)) ? icon : null; }

  /** A short human name from about.md's first line ("今日對話次數（圓餅圖）：…" → "今日對話次數"). */
  shortTitle(name: string): string | null {
    const first = this.about(name).split(/\r?\n/)[0] ?? "";
    const at = [...first].findIndex((c) => "：:（(—,，。".includes(c));
    const title = at >= 0 ? [...first].slice(0, at).join("").trim() : "";
    return !title || [...title].length > 24 || title === name ? null : title;
  }

  /** Each component with its whole about.md (`catalog(of:)`): "- name: first line" and the rest indented. */
  catalog(of: string[]): string {
    return this.names.filter((name) => of.includes(name)).map((name) => {
      const lines = this.about(name).trim().split("\n");
      const rest = lines.slice(1).map((line) => `  ${line}`).join("\n");
      return `- ${name}: ${lines[0] ?? ""}${rest ? `\n${rest}` : ""}`;
    }).join("\n");
  }

  /** The first line of each one's about.md (`summaries(of:)`). */
  summaries(of: string[]): string {
    return this.names.filter((name) => of.includes(name)).map((name) => `- ${name}: ${this.about(name).trim().split("\n")[0] ?? ""}`).join("\n");
  }

  /** The components `text` names with /Name (`mentioned(in:)`), in the order they are named. */
  mentioned(text: string): string[] {
    return componentMentions(text, this.names);
  }

  /** What goes to the bot, unseen, with a message that names components with / (`mentionNote(for:)`). */
  mentionNote(text: string): string | null {
    const named = this.mentioned(text);
    if (!named.length) return null;
    const one = named.length === 1;
    const list = named.map((name) => `"${name}"`).join(", ");
    return `(App: With / the user names the in-chat component${one ? "" : "s"} ${list}: they mean ${one ? "that component" : "those components"} of the app's chat. <show name="name">JSON</show> draws one; <component name="name">request</component> asks Maintainer to change one. How to use ${one ? "it" : "them"}:\n${this.catalog(named)})`;
  }

  /** What the page needs to draw it (`ChatPayload.ComponentInfo`). */
  info(name: string): ComponentInfoData | null {
    const template = this.template(name);
    if (template === null) return null;
    return {
      template, version: this.versions.get(name) ?? 0, updated: this.updated.has(name), working: this.working.has(name), hasPrevious: this.hasPrevious(name),
      sizes: this.sizes(name), icon: this.icon(name), title: this.shortTitle(name),
    };
  }

  // ------------------------------------------------------------------------------------------
  // Changing (Maintainer's work, git history)

  /** How many times its template changed since the app started (`versions[name]`). */
  versionOf(name: string): number { return this.versions.get(name) ?? 0; }

  /** Maintainer was asked to change `name`: shown as being worked on (`markWorking`). */
  markWorking(name: string, change: string) {
    const safe = safeName(name);
    if (this.working.get(safe) === change) return;
    this.working.set(safe, change);
    this.stamp++;
  }

  /** `name` is built (a spec's component landed): no longer worked on (`doneWorking`). */
  doneWorking(name: string) {
    if (this.working.delete(safeName(name))) this.stamp++;
  }

  /** Maintainer finished its turn (`finishWorking`; the caller has looked at the library first, as 1.x's rescan does). */
  finishWorking() {
    if (!this.working.size) return;
    this.working.clear();
    this.stamp++;
  }

  /** The library's git became ready (or changed under it): ask it again (`forgetHistory`). */
  forgetHistory() {
    this.previous.clear();
    this.stamp++;
  }

  /** The component's folder relative to the plugin library, when it is inside it (`gitPath`). */
  private gitPath(name: string): string | null {
    if (!this.git) return null;
    const base = this.git.folder.replace(/\/+$/, "") + "/";
    const path = join(this.home(name), name);
    return path.startsWith(base) ? path.slice(base.length) : null;
  }

  /** There is an earlier version in git to go back to (`hasPrevious`); asked once per change. */
  hasPrevious(name: string): boolean {
    const known = this.previous.get(name);
    if (known !== undefined) return known;
    const path = this.gitPath(name);
    let answer = false;
    try { answer = !!path && !!this.git?.hasPrevious(path); } catch { answer = false; }
    this.previous.set(name, answer);
    return answer;
  }

  /** Puts back the version from before the last change (git), then redraws (`revert`). Null when done, else why not. */
  revert(name: string): string | null {
    const path = this.gitPath(name);
    if (!this.git || !path || !this.names.includes(name)) return "This component has no version history.";
    const problem = this.git.revert(path, `component ${name}`);
    this.updated.delete(name);
    this.previous.delete(name);
    this.rescan();
    this.stamp++;
    return problem;
  }

  /** When its files last changed (`stamp(of:)`): a request to change it is settled once this moves. */
  stampOf(name: string): string {
    return `${this.modified.get(name) ?? -1}:${this.aboutModified.get(name) ?? -1}`;
  }

  private mtime(path: string): number {
    try { return statSync(path).mtimeMs; } catch { return -1; }
  }

  /** Picks up components added, removed or changed on disk. True when what bots are told changed (a component came or went, an about.md changed). */
  rescan(): boolean {
    const found = new Set<string>();
    for (const root of this.roots()) {
      let entries: string[] = [];
      try { entries = readdirSync(root); } catch { continue; }
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        if (existsSync(join(root, entry, "template.html"))) found.add(entry);
      }
    }
    const names = [...found].sort();
    const first = this.modified.size === 0 && this.names.length === 0;
    let catalogChanged = false;
    if (names.join("\n") !== this.names.join("\n")) {
      catalogChanged = !first;
      this.names = names;
      this.stamp++;
    }
    for (const name of names) {
      const home = this.home(name);
      const template = this.mtime(join(home, name, "template.html"));
      const known = this.modified.get(name);
      if (known !== template) {
        if (known !== undefined) {
          this.versions.set(name, (this.versions.get(name) ?? 0) + 1);
          this.updated.add(name);
        }
        this.modified.set(name, template);
        this.previous.delete(name);
        this.stamp++;
      }
      const about = this.mtime(join(home, name, "about.md"));
      if (this.aboutModified.get(name) !== about) {
        if (this.aboutModified.has(name)) catalogChanged = true;
        this.aboutModified.set(name, about);
        this.previous.delete(name);
        this.stamp++;
      }
    }
    return catalogChanged;
  }
}

/** Besides whitespace and non-ASCII text, what a `/name` may follow (`ComponentMentions.startsAfter`). */
export const MENTION_STARTS_AFTER = "([{\"'";
/** Besides ASCII letters and digits, what a name is made of (`ComponentMentions.nameCharacters`). */
export const MENTION_NAME_CHARACTERS = "_-/";

/**
 * The names `text` has as `/name`, in the order they come (`ComponentMentions.names(in:among:)`). Longer
 * names win, so a name that starts another is not read inside it. The slash starts a word (after
 * whitespace, a bracket or quote, or non-ASCII text such as Chinese), so "用/網頁預覽卡片" counts but
 * "a/choices" and "~/choices" do not; only ASCII letters, digits, _, - and / end a name.
 */
export function componentMentions(text: string, names: readonly string[]): string[] {
  const lower = text.toLowerCase();
  const wordCharacter = (c: string) => /^[A-Za-z0-9]$/.test(c) || MENTION_NAME_CHARACTERS.includes(c);
  const startsAfter = (c: string) => /[^\x00-\x7f]/.test(c) || /\s/.test(c) || MENTION_STARTS_AFTER.includes(c);
  const found: { at: number; name: string }[] = [];
  const taken: [number, number][] = [];
  const unique = [...new Set(names)].filter((name) => name).sort((a, b) => [...b].length - [...a].length);
  for (const name of unique) {
    const needle = "/" + name.toLowerCase();
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length;
      from = end;
      const before = at === 0 ? "" : String.fromCodePoint(lower.codePointAt(at - 1 - (at >= 2 && /[\udc00-\udfff]/.test(lower[at - 1]!) ? 1 : 0))!);
      const startsWord = at === 0 || startsAfter(before);
      const endsWord = end === lower.length || !wordCharacter(lower[end]!);
      if (!startsWord || !endsWord || taken.some(([a, b]) => a < end && at < b)) continue;
      taken.push([at, end]);
      if (!found.some((entry) => entry.name === name)) found.push({ at, name });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.name);
}

/** What a bot is told about components (`ComponentKnowledge`): its own with their whole usage, one line for each of the rest. */
export interface ComponentKnowledge {
  own: { name: string; text: string }[];
  others: { name: string; text: string }[];
  limit: number;
}

export function knowledgeFull(k: ComponentKnowledge): string {
  let text = `(App: Components in the chat: ${k.own.length} / ${k.limit} yours, each with its usage below (a bot has at most ${k.limit}). <show name="name">JSON</show> draws one; <show name="name" command="git diff --stat"></show> fills it with what that command prints instead (run in your project folder once the user allows it; JSON output is used as the data, other output as one string; the card has a refresh button). A component whose usage has a "Command:" line needs only <show name="name"></show>; any other one (even with a "Board command:" line, which the chat never runs) needs its JSON inside the tag, and an empty one draws nothing; add refresh="2s" to rerun a command card every 2 seconds while it is on screen (a usage with a "Refresh: every 2s" line does so already). Give a card an id, <show name="name" id="tests">JSON</show>, and a later <show> with the same id updates that card in place instead of adding a new one when it is all your reply holds (for progress you keep up to date); with words it moves the card under them. Cards may keep state the user changes (ccb.save); you get it with the user's next message. <component name="name">request</component> asks Maintainer to change one, make a new one, or give you one from the shared library.)\n` + k.own.map((e) => e.text).join("\n");
  if (k.others.length) text += `\n(App: Also in the shared library, not yours yet, one line each. To use one, ask Maintainer for it with <component name="name">add it to my list</component>; you then get its usage.)\n` + k.others.map((e) => e.text).join("\n");
  return text;
}

/** Only what changed since `told`; null when nothing did (`changes(since:)`). */
export function knowledgeChanges(k: ComponentKnowledge, told: ComponentKnowledge): string | null {
  const toldOwn = new Map(told.own.map((e) => [e.name, e.text]));
  const toldOthers = new Map(told.others.map((e) => [e.name, e.text]));
  const library = new Set([...k.own.map((e) => e.name), ...k.others.map((e) => e.name)]);
  const added = k.own.filter((e) => !toldOwn.has(e.name));
  const changed = k.own.filter((e) => toldOwn.has(e.name) && toldOwn.get(e.name) !== e.text);
  const dropped = k.others.filter((e) => toldOwn.has(e.name));
  const gone = [...told.own, ...told.others].map((e) => e.name).filter((name) => !library.has(name));
  const shelf = k.others.filter((e) => !toldOwn.has(e.name) && toldOthers.get(e.name) !== e.text);
  const parts: string[] = [];
  if (added.length) parts.push(`New on your list, with usage:\n${added.map((e) => e.text).join("\n")}`);
  if (changed.length) parts.push(`Usage changed (this replaces what you had):\n${changed.map((e) => e.text).join("\n")}`);
  if (dropped.length) parts.push(`No longer yours (still in the shared library; ask Maintainer to get one back):\n${dropped.map((e) => e.text).join("\n")}`);
  if (gone.length) parts.push(`Gone from the library: ${gone.join(", ")}`);
  if (shelf.length) parts.push(`New or changed in the shared library, not yours yet:\n${shelf.map((e) => e.text).join("\n")}`);
  if (!parts.length) return null;
  return `(App: Components were updated; only what changed since you were last told, the rest is as before. You have ${k.own.length} / ${k.limit}.)\n${parts.join("\n")}`;
}
