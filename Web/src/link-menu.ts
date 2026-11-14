// Plugins' buttons beside a link in a message (`contributes.menus["chat/link"]`). While the pointer rests on a link (a reply's
// markdown link chip, or a file chip of a line's attachments) or it has keyboard focus, the entries whose `when` matches the
// link show in a small bar floating over the chat next to it: the preview card's hover bar (same tokens, dark and light), out
// of the page's flow so no line moves. A click runs the entry's command (the app page checks it is offered, the core that the
// link is in that line); the link's own click opens it as before. No entries: nothing is listened for here at all.
//
// Matching goes by the link's parsed address only (desktop/src/browser-tab-menu.ts `tabMatches`, of which this is the chat
// page's copy): `scheme` ("file", "http", "https"), `ext` (the file name's extension, any case, without query or hash) and
// `host` (web links; "*.example.org" for it and its subdomains). Never a pattern a plugin wrote, run over text.
import { post } from "./bridge";
import { t } from "./i18n";
import type { LinkMenuItem } from "./types";

/** The `chat/link` entries now (from ChatState.linkMenu; none in a worker's read-only view). */
export const linkMenu: { items: LinkMenuItem[] } = { items: [] };

/** More entries than this match: the first ones and a "⋯" with the rest. */
const ROW_MAX = 3;
/** How long the bar waits after the pointer leaves link and bar (it may be on its way from one to the other). */
const LEAVE_MS = 180;
const ATTACHMENT = "botling-chat://chat/attachment/";
/** The links a bar is for: link chips and attachment chips in your lines and the bots' replies. */
const LINKS = ".row.bot[data-id] a.chip[data-url], .row.user[data-id] a.chip[data-url], .row.bot[data-id] a.file-chip[data-url]:not(.missing), .row.user[data-id] a.file-chip[data-url]:not(.missing)";

const moreIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`;
const icons: Record<string, string> = {
  cube: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>`,
  book: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>`,
};

/** The file: URL a chat attachment link stands for (its base64url ref), or null. */
function attachmentRef(href: string): string | null {
  const ref = href.slice(ATTACHMENT.length).split(/[?#]/)[0]!.split("/")[1];
  if (!ref) return null;
  try {
    const binary = atob(ref.replaceAll("-", "+").replaceAll("_", "/"));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    return text.startsWith("file:") ? text : null;
  } catch {
    return null;
  }
}

/**
 * The address a link is matched by: a web or file: URL as written, an absolute path as its file: URL, a chat attachment as
 * the file it names; null for anything else (a relative path, mailto:, a picture's data:).
 */
export function linkAddress(href: string): URL | null {
  const text = href.startsWith(ATTACHMENT) ? attachmentRef(href) : href;
  if (!text) return null;
  const spelled = /^(https?|file):/i.test(text) ? text : text.startsWith("/") && !text.startsWith("//") ? `file://${text}` : null;
  if (!spelled) return null;
  try { return new URL(spelled); } catch { return null; }
}

/** Whether a link shows an entry with this `when` (none: every link the bar is for). */
export function linkMatches(when: LinkMenuItem["when"], href: string): boolean {
  const u = linkAddress(href);
  if (!u) return false;
  if (!when) return true;
  if (when.scheme && u.protocol.replace(/:$/, "").toLowerCase() !== when.scheme) return false;
  if (when.host) {
    const host = u.hostname.toLowerCase();
    if (when.host.startsWith("*.")) {
      const base = when.host.slice(2);
      if (host !== base && !host.endsWith(`.${base}`)) return false;
    } else if (host !== when.host) return false;
  }
  if (when.ext) {
    let name = u.pathname.split("/").pop() ?? "";
    try { name = decodeURIComponent(name); } catch { /* keep it as written */ }
    const dot = name.lastIndexOf(".");
    if (dot < 0 || !when.ext.includes(name.slice(dot + 1).toLowerCase())) return false;
  }
  return true;
}

/** The entries a link shows. */
export function linkItemsFor(href: string): LinkMenuItem[] {
  return linkMenu.items.filter((item) => linkMatches(item.when, href));
}

/** The bar now shown, the link it is for, and its "⋯" list when open. */
let shown: { bar: HTMLElement; link: HTMLElement; list: HTMLElement | null } | null = null;
let leaveTimer: ReturnType<typeof setTimeout> | null = null;
const installed = new WeakSet<Document>();

const cancelLeave = () => { if (leaveTimer !== null) { clearTimeout(leaveTimer); leaveTimer = null; } };
const inside = (node: unknown) => node instanceof Node && !!shown && (shown.bar.contains(node) || shown.link.contains(node) || !!shown.list?.contains(node));
const eligible = (target: EventTarget | null): HTMLElement | null =>
  target instanceof Element ? target.closest<HTMLElement>(LINKS) : null;

/** Takes the bar (and its list) away. */
export function hideLinkBar(): void {
  cancelLeave();
  shown?.list?.remove();
  shown?.bar.remove();
  shown = null;
}

function runEntry(item: LinkMenuItem, link: HTMLElement): void {
  const row = link.closest<HTMLElement>(".row[data-id]");
  const url = link.dataset.url;
  hideLinkBar();
  if (!row?.dataset.id || !url) return;
  post({ type: "linkCommand", id: item.command, messageID: row.dataset.id, url });
}

function entryButton(item: LinkMenuItem, link: HTMLElement): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "preview-make";
  button.dataset.command = item.command;
  button.innerHTML = `${(item.icon && icons[item.icon]) || ""}<span></span>`;
  button.querySelector("span")!.textContent = item.title;
  button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); runEntry(item, link); });
  return button;
}

/** "⋯": the entries that did not fit the row, as the reply menu's list. */
function moreButton(rest: LinkMenuItem[], link: HTMLElement): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "preview-make link-more";
  button.setAttribute("aria-label", t("messages.more"));
  button.setAttribute("aria-haspopup", "menu");
  button.innerHTML = moreIcon;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!shown) return;
    if (shown.list) { shown.list.remove(); shown.list = null; return; }
    const list = document.createElement("div");
    list.className = "message-menu link-menu-list";
    list.setAttribute("role", "menu");
    for (const item of rest) {
      const entry = document.createElement("button");
      entry.type = "button";
      entry.setAttribute("role", "menuitem");
      entry.dataset.command = item.command;
      entry.textContent = item.title;
      entry.addEventListener("click", (click) => { click.stopPropagation(); runEntry(item, link); });
      list.append(entry);
    }
    list.addEventListener("mouseover", cancelLeave);
    document.body.append(list);
    const box = button.getBoundingClientRect();
    list.style.top = `${box.bottom + 4}px`;
    list.style.left = `${Math.max(8, Math.min(box.right - list.offsetWidth, window.innerWidth - list.offsetWidth - 8))}px`;
    shown.list = list;
    (list.querySelector("button") as HTMLButtonElement | null)?.focus();
  });
  return button;
}

/** Shows the bar for `link` (or none, when no entry matches it). */
export function showLinkBar(link: HTMLElement): void {
  cancelLeave();
  if (shown?.link === link) return;
  hideLinkBar();
  const items = linkItemsFor(link.dataset.url ?? "");
  if (!items.length) return;
  const bar = document.createElement("div");
  bar.className = "link-bar";
  bar.setAttribute("role", "toolbar");
  const fits = items.length <= ROW_MAX ? items : items.slice(0, ROW_MAX - 1);
  for (const item of fits) bar.append(entryButton(item, link));
  if (fits.length < items.length) bar.append(moreButton(items.slice(fits.length), link));
  bar.addEventListener("mouseover", cancelLeave);
  bar.addEventListener("mouseout", (event) => { if (!inside(event.relatedTarget)) leaveSoon(); });
  bar.addEventListener("keydown", (event) => barKey(event as KeyboardEvent));
  bar.addEventListener("focusout", (event) => { if (!inside((event as FocusEvent).relatedTarget)) leaveSoon(0); });
  document.body.append(bar);
  shown = { bar, link, list: null };
  place(bar, link);
}

/** Over the link's end (under it when there is no room above), kept inside the window. */
function place(bar: HTMLElement, link: HTMLElement): void {
  const rects = link.getClientRects();
  const box = rects.length ? rects[rects.length - 1]! : link.getBoundingClientRect();
  const height = bar.offsetHeight || 32;
  const width = bar.offsetWidth || 120;
  const top = box.top - height - 4 >= 4 ? box.top - height - 4 : box.bottom + 4;
  bar.style.top = `${Math.round(top)}px`;
  bar.style.left = `${Math.round(Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8)))}px`;
}

function leaveSoon(ms = LEAVE_MS): void {
  cancelLeave();
  leaveTimer = setTimeout(() => { leaveTimer = null; hideLinkBar(); }, ms);
}

/** The first focusable element after `link` in the page (Tab out of the bar goes on from the link, as without it). */
function nextFocusable(link: HTMLElement): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>('a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])')];
  return all.find((element) => !shown?.bar.contains(element) && !link.contains(element) && !!(link.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)) ?? null;
}

/** Inside the bar: Tab and Shift+Tab move between its buttons, out at the ends (back to the link, or on past it); Escape closes it. */
function barKey(event: KeyboardEvent): void {
  if (!shown) return;
  const link = shown.link;
  if (event.key === "Escape") { event.preventDefault(); hideLinkBar(); link.focus(); return; }
  if (event.key !== "Tab") return;
  const buttons = [...shown.bar.querySelectorAll<HTMLButtonElement>("button")];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  event.preventDefault();
  if (event.shiftKey) { if (at > 0) buttons[at - 1]!.focus(); else link.focus(); return; }
  if (at < buttons.length - 1) { buttons[at + 1]!.focus(); return; }
  const next = nextFocusable(link);
  hideLinkBar();
  next?.focus();
}

/** Listens on the page once; while no plugin has an entry, every listener returns at once. */
export function installLinkMenu(root: Document = document): void {
  if (installed.has(root)) return;
  installed.add(root);
  root.addEventListener("mouseover", (event) => {
    if (!linkMenu.items.length) return;
    const link = eligible(event.target);
    if (link) showLinkBar(link);
  });
  root.addEventListener("mouseout", (event) => {
    if (!shown || !shown.link.contains(event.target as Node)) return;
    if (!inside(event.relatedTarget)) leaveSoon();
  });
  root.addEventListener("focusin", (event) => {
    if (!linkMenu.items.length) return;
    const link = eligible(event.target);
    if (link) showLinkBar(link);
  });
  root.addEventListener("focusout", (event) => {
    if (!shown || !shown.link.contains(event.target as Node)) return;
    if (!inside((event as FocusEvent).relatedTarget)) leaveSoon();
  });
  // Tab from a link with its bar: into the bar's first button. Escape: the bar goes.
  root.addEventListener("keydown", (event) => {
    if (!shown || event.target !== shown.link) return;
    if (event.key === "Escape") { hideLinkBar(); return; }
    if (event.key === "Tab" && !event.shiftKey) {
      const first = shown.bar.querySelector<HTMLButtonElement>("button");
      if (first) { event.preventDefault(); first.focus(); }
    }
  });
  // The chat scrolled or the window changed: the bar no longer sits by its link.
  root.addEventListener("scroll", (event) => { if (shown && !(event.target instanceof Node && shown.list?.contains(event.target))) hideLinkBar(); }, true);
  window.addEventListener("resize", () => hideLinkBar());
  root.addEventListener("pointerdown", (event) => { if (shown?.list && !inside(event.target)) { shown.list.remove(); shown.list = null; } }, true);
}

/** New entries from the app (ChatState.linkMenu): a bar now open goes, since what it offers may have changed. */
export function setLinkMenu(items: LinkMenuItem[]): void {
  if (JSON.stringify(items) === JSON.stringify(linkMenu.items)) return;
  linkMenu.items = items;
  hideLinkBar();
}
