// The page a plugin panel runs in (1.x: `chat.html?panel=plugin/id`, the plugin's web part in the
// chat page). 2.0 runs the web part in its own sandboxed frame instead: botling-card://page/<token>
// (opaque origin, no network, no storage, no bridge), served by main under PANEL_CSP. The page gets a
// small `ccb`: panels.register, settings, notify, commands (and `command(id, ...args)`, Botling's
// openChat / openResult too), host.call or call (to what its own program part exposes, through the app
// page's frame broker and the core; Web/src/frame-protocol.ts), tile (a library component's card page it
// may put in a frame of its own) and requestApproval (asks the user, on the app page's ApprovalSheet, to
// allow a bot's command). What only the chat page could lend (the input box, markdown, components) does
// nothing here. It also hears what the page pushes (`ccb.on(name, fn)`: its program part's `ui.emit`, and for a `bottomPanel`
// view "visible" and "toggle"), may ask to be shown or hidden (`ccb.panel.setVisible`) and may hand the page a key
// combination it did not use (`ccb.forwardKey(event)`, for the page's shortcuts).
const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(new RegExp("\u2028", "g"), "\\u2028").replace(new RegExp("\u2029", "g"), "\\u2029");

/**
 * The page's look follows the app's (Settings → Appearance → App): a frame's prefers-color-scheme is the
 * color-scheme of the page that holds it, and <html data-theme> switches the design tokens plugins put in
 * (Web/src/tokens.css) and their own `[data-theme="light"]` rules. Runs first, before anything draws.
 */
export const PANEL_THEME_SCRIPT = `(() => { const q = matchMedia("(prefers-color-scheme: light)"), r = document.documentElement; const f = () => r.setAttribute("data-theme", q.matches ? "light" : "dark"); f(); q.addEventListener("change", f); })();`;

/**
 * `fit`: the frame is a block of the app page's own (a page of Settings, a block in the gear's popover), not a panel:
 * no padding or background of its own, the app's text size, and its height told to the page (`resize`) as its content changes.
 */
export interface PanelFit { fontSize: number }

/** `context`: what the page around it is about (the bot a block of its right panel or a tab of its header belongs to), as `ccb.context`. */
export function panelPage(plugin: string, panel: string, source: string, settings: Record<string, unknown>, fit?: PanelFit, context: Record<string, string> = {}): string {
  const look = fit
    ? `html, body { margin: 0; background: transparent; color: #EDEDF0; font: ${Math.round(fit.fontSize)}px/1.5 -apple-system, "PingFang TC", "Noto Sans TC", "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  * { box-sizing: border-box; }
  #panel-root { display: flow-root; overflow-wrap: anywhere; }
  button { font: inherit; color: inherit; }`
    : `html, body { margin: 0; background: #1B1B1F; color: #EDEDF0; font: 13px/1.5 -apple-system, "PingFang TC", "Noto Sans TC", "Segoe UI", sans-serif; }
  #panel-root { padding: 12px; overflow-wrap: anywhere; }`;
  return `<!doctype html>
<html data-surface="panel" data-theme="dark"><head><meta charset="utf-8">
<script>${PANEL_THEME_SCRIPT}</script>
<style>
  :root { color-scheme: dark; }
  ${look}
  pre { white-space: pre-wrap; }
  .panel-empty, .panel-failed { color: #8E8E96; }
  .panel-failed { color: #FF8A80; }
  :root[data-theme="light"] { color-scheme: light; }
  :root[data-theme="light"] body { color: #1C1C1F;${fit ? "" : " background: #FFFFFF;"} }
  :root[data-theme="light"] .panel-empty { color: #7A7A83; }
  :root[data-theme="light"] .panel-failed { color: #D0342C; }
</style></head>
<body><div id="panel-root"></div>
<script type="module">
const NAME = ${json(plugin)}, PANEL = ${json(panel)}, SOURCE = ${json(source)};
let SETTINGS = ${json(settings)};
const FIT = ${json(!!fit)};
const CONTEXT = Object.freeze(${json(context)});
const root = document.getElementById("panel-root");
const post = (message) => parent.postMessage(message, "*");
const waiting = new Map();
let next = 0;
const settingHandlers = new Map();
const pushHandlers = new Map();
const panels = new Map();
const commands = new Map();
let dispose = null;
addEventListener("message", (event) => {
  if (event.source !== parent) return;
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.ccb === "reply" && waiting.has(message.id)) {
    const { resolve, reject } = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.ok) resolve(message.value); else reject(new Error(String(message.value)));
  } else if (message.ccb === "event" && typeof message.name === "string") {
    for (const handler of [...(pushHandlers.get(message.name) || [])]) { try { handler(message.data); } catch (error) { fail(error); } }
  }
});
const nothing = () => () => {};
/** A request the page answers (a reply with the same id). */
function ask(message) {
  return new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject });
    post({ ...message, id });
  });
}
function draw() {
  const render = panels.get(PANEL);
  if (!render) { root.innerHTML = '<p class="panel-empty">This panel is not ready.</p>'; return; }
  if (typeof dispose === "function") { try { dispose(); } catch {} }
  root.innerHTML = "";
  try { dispose = render(root); } catch (error) { fail(error); }
}
function fail(error) {
  const text = String((error && error.message) || error);
  root.innerHTML = "";
  const p = document.createElement("p");
  p.className = "panel-failed";
  p.textContent = "The panel failed: " + text;
  root.append(p);
  post({ ccb: "error", message: text.slice(0, 2000) });
}
const ccb = {
  name: NAME,
  context: CONTEXT,
  panels: { register(id, render) { panels.set(String(id), render); if (String(id) === PANEL) draw(); return () => panels.delete(String(id)); } },
  settings: {
    get: (key) => SETTINGS[key],
    onChange(key, handler) { const list = settingHandlers.get(key) || []; list.push(handler); settingHandlers.set(key, list); return () => list.splice(list.indexOf(handler), 1); },
  },
  notify: (text) => post({ ccb: "notify", text: String(text).slice(0, 4000) }),
  commands: {
    register(id, run) { commands.set(String(id), run); return () => commands.delete(String(id)); },
    // Its own (registered here, or in its program part), or Botling's openChat(botId) / openResult(botId, url).
    execute(id, ...args) {
      const run = commands.get(String(id));
      if (run) { try { run(...args); } catch (error) { fail(error); } }
      else post(args.length ? { ccb: "command", id: String(id), args: args.map(String) } : { ccb: "command", id: String(id) });
    },
  },
  command: (id, ...args) => ccb.commands.execute(id, ...args),
  host: {
    call: (method, params) => ask({ ccb: "call", method: String(method), params: params === undefined ? null : params }),
  },
  call: (method, params) => ccb.host.call(method, params),
  /** Hears event "name" the page pushes (the program part's ui.emit; "visible" and "toggle" for a bottomPanel view). */
  on(name, handler) { const list = pushHandlers.get(String(name)) || []; list.push(handler); pushHandlers.set(String(name), list); return () => list.splice(list.indexOf(handler), 1); },
  /** A bottomPanel view: asks the page to show or hide it. */
  panel: { setVisible: (visible) => post({ ccb: "panel", visible: !!visible }) },
  /** A key combination this frame did not use (a modifier held), handed to the page so its shortcuts work from here too. */
  forwardKey(event) {
    if (!event || !(event.metaKey || event.ctrlKey || event.altKey)) return;
    post({ ccb: "key", key: String(event.key).slice(0, 32), code: String(event.code).slice(0, 32), metaKey: !!event.metaKey, ctrlKey: !!event.ctrlKey, altKey: !!event.altKey, shiftKey: !!event.shiftKey });
  },
  /** A component of the library as a tile ({ component, data, size: "1x1" | "2x1" | "2x2", botId }): the URL of its page, for an iframe of this page's own. */
  tile: (spec) => ask({ ccb: "tile", component: String(spec?.component ?? ""), data: spec?.data === undefined ? null : spec.data, size: String(spec?.size ?? ""), botId: String(spec?.botId ?? "") }),
  /** A component of the library drawn as in a chat reply ({ component, data, botId }): the URL of its page, for an iframe of this page's own; it posts { ccb: "size", height } here and takes { ccbData }. */
  card: (spec) => ask({ ccb: "card", component: String(spec?.component ?? ""), data: spec?.data === undefined ? null : spec.data, botId: String(spec?.botId ?? "") }),
  /** A picture of a part of this frame ({ botId, rect: { x, y, width, height } } in its CSS px) kept in the bot's note-assets: resolves { ref, url }. */
  snapshot: (spec) => ask({ ccb: "snapshot", botId: String(spec?.botId ?? ""), rect: { x: Number(spec?.rect?.x), y: Number(spec?.rect?.y), width: Number(spec?.rect?.width), height: Number(spec?.rect?.height) } }),
  /** Opens a link of the bot's note as the chat opens one (href as the note has it; relative: against the note's folder): web links in the default browser, .md in the app's report preview, other files with their app. Resolves { opened }. */
  openLink: (href, opts) => ask({ ccb: "openLink", href: String(href ?? ""), botId: String(opts?.botId ?? "") }),
  /** Asks the user to allow a bot's command in its folder ({ botId, command, folder, card? }); resolves { allowed }. */
  requestApproval: (req) => ask({ ccb: "approval", botId: String(req?.botId ?? ""), command: String(req?.command ?? ""), folder: String(req?.folder ?? ""), ...(req?.card != null ? { card: String(req.card) } : {}), ...(req?.detail != null ? { detail: String(req.detail) } : {}) }),
  // Only the chat page can lend these; in a panel frame they do nothing.
  composer: { element: null, view: null, getText: () => "", insert() {}, addExtension: nothing, showPopover: nothing, onKeyDown: nothing },
  messages: { use() {}, afterRender: nothing },
  components: { register: nothing },
  codemirror: {},
};
if (FIT && typeof ResizeObserver === "function") {
  let last = -1;
  const tell = () => { const height = Math.ceil(root.getBoundingClientRect().height); if (height !== last) { last = height; post({ ccb: "resize", height }); } };
  new ResizeObserver(tell).observe(root);
  tell();
}
try {
  const url = URL.createObjectURL(new Blob([SOURCE], { type: "text/javascript" }));
  const module = await import(url);
  URL.revokeObjectURL(url);
  const activate = module.activate || (module.default && module.default.activate);
  if (typeof activate !== "function") throw new Error("The web part does not export activate(ccb).");
  await activate(ccb);
  if (!panels.has(PANEL)) draw();
  post({ ccb: "ready" });
} catch (error) {
  fail(error);
}
</script></body></html>`;
}
