// The page a plugin panel runs in (1.x: `chat.html?panel=plugin/id`, the plugin's web part in the
// chat page). 2.0 runs the web part in its own sandboxed frame instead: botling-card://page/<token>
// (opaque origin, no network, no storage, no bridge), served by main under PANEL_CSP. The page gets a
// small `ccb`: panels.register, settings, notify, commands, host.call (to its own program part, through
// the app page and the core). What only the chat page could lend (the input box, markdown, components)
// does nothing here.
const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(new RegExp("\u2028", "g"), "\\u2028").replace(new RegExp("\u2029", "g"), "\\u2029");

export function panelPage(plugin: string, panel: string, source: string, settings: Record<string, unknown>): string {
  return `<!doctype html>
<html data-surface="panel"><head><meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; background: #1B1B1F; color: #EDEDF0; font: 13px/1.5 -apple-system, "PingFang TC", "Noto Sans TC", "Segoe UI", sans-serif; }
  #panel-root { padding: 12px; overflow-wrap: anywhere; }
  pre { white-space: pre-wrap; }
  .panel-empty, .panel-failed { color: #8E8E96; }
  .panel-failed { color: #FF8A80; }
</style></head>
<body><div id="panel-root"></div>
<script type="module">
const NAME = ${json(plugin)}, PANEL = ${json(panel)}, SOURCE = ${json(source)};
let SETTINGS = ${json(settings)};
const root = document.getElementById("panel-root");
const post = (message) => parent.postMessage(message, "*");
const waiting = new Map();
let next = 0;
const settingHandlers = new Map();
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
  }
});
const nothing = () => () => {};
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
  panels: { register(id, render) { panels.set(String(id), render); if (String(id) === PANEL) draw(); return () => panels.delete(String(id)); } },
  settings: {
    get: (key) => SETTINGS[key],
    onChange(key, handler) { const list = settingHandlers.get(key) || []; list.push(handler); settingHandlers.set(key, list); return () => list.splice(list.indexOf(handler), 1); },
  },
  notify: (text) => post({ ccb: "notify", text: String(text).slice(0, 4000) }),
  commands: {
    register(id, run) { commands.set(String(id), run); return () => commands.delete(String(id)); },
    execute(id) { const run = commands.get(String(id)); if (run) { try { run(); } catch (error) { fail(error); } } else post({ ccb: "command", id: String(id) }); },
  },
  host: {
    call(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++next;
        waiting.set(id, { resolve, reject });
        post({ ccb: "call", id, method: String(method), params: params === undefined ? null : params });
      });
    },
  },
  // Only the chat page can lend these; in a panel frame they do nothing.
  composer: { element: null, view: null, getText: () => "", insert() {}, addExtension: nothing, showPopover: nothing, onKeyDown: nothing },
  messages: { use() {}, afterRender: nothing },
  components: { register: nothing },
  codemirror: {},
};
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
