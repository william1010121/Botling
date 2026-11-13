// A plugin's button in the browser pane's toolbar (`contributes.menus["browser/tab"]`): its `when` says which tabs show it,
// by the tab's address: `scheme` ("file", "https"…), `ext` (the file's extension, one or a list: "pdf") and `host`
// ("arxiv.org", or "*.github.com" for it and its subdomains). Pure: the core reads manifests with it, the app page
// filters the toolbar with it, and the core checks a click with it again.

export interface TabWhen { scheme?: string; ext?: string[]; host?: string }

const WORD = /^[a-z0-9.*+-]{1,100}$/;

/** A manifest's `when` for a browser/tab entry, cleaned (lower case, no leading dot), or why it is not one. */
export function parseTabWhen(raw: unknown): { when?: TabWhen; problem?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problem: "when must be an object with scheme, ext or host." };
  const entries = Object.entries(raw as Record<string, unknown>);
  const unknown = entries.find(([key]) => key !== "scheme" && key !== "ext" && key !== "host");
  if (unknown || !entries.length) return { problem: `when may only say scheme, ext or host${unknown ? ` (not "${unknown[0].slice(0, 40)}")` : ""}.` };
  const when: TabWhen = {};
  const { scheme, ext, host } = raw as Record<string, unknown>;
  if (scheme !== undefined) {
    if (typeof scheme !== "string" || !WORD.test(scheme.toLowerCase())) return { problem: "when.scheme must be a word such as \"file\" or \"https\"." };
    when.scheme = scheme.toLowerCase().replace(/:$/, "");
  }
  if (ext !== undefined) {
    const list = typeof ext === "string" ? [ext] : Array.isArray(ext) ? ext : null;
    const clean = list?.map((item) => (typeof item === "string" ? item.toLowerCase().replace(/^\./, "") : ""));
    if (!clean || !clean.length || clean.length > 20 || clean.some((item) => !/^[a-z0-9]{1,20}$/.test(item))) return { problem: "when.ext must be an extension such as \"pdf\", or a list of them." };
    when.ext = clean;
  }
  if (host !== undefined) {
    if (typeof host !== "string" || !WORD.test(host.toLowerCase())) return { problem: "when.host must be a host such as \"arxiv.org\" or \"*.github.com\"." };
    when.host = host.toLowerCase();
  }
  return { when };
}

/** Whether a tab at `url` shows a button with this `when` (none: every tab). */
export function tabMatches(when: (Omit<TabWhen, "ext"> & { ext?: string | string[] }) | undefined, url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
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
    const exts = typeof when.ext === "string" ? [when.ext] : when.ext;
    if (dot < 0 || !exts.includes(name.slice(dot + 1).toLowerCase())) return false;
  }
  return true;
}
