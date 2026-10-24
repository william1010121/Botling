// The plugin library (1.x: Settings → Plugins): each plugin on or off, its settings (a secret is only
// ever sent, never shown back: the page knows whether it is set), its commands, and its panels, which
// open in a sandboxed frame (panel-page.ts). A small stand-in until 2.0 has 1.x's Settings window.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginView, PluginsView } from "../contract";
import { Client, RequestFailed } from "./client";
import { panelPage } from "./panel-page";

const why = (failure: unknown) => (failure instanceof RequestFailed ? failure.error.message : String((failure as Error)?.message ?? failure));

export function PluginsButton({ client, plugins }: { client: Client; plugins: PluginsView | null }) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<{ plugin: string; id: string; title: string } | null>(null);
  const broken = (plugins?.plugins.some((plugin) => plugin.failure) ?? false) || (plugins?.broken.length ?? 0) > 0;
  return (
    <div className="rail-plugins">
      <button type="button" className={`rail-button${open ? " on" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        Plugins{broken && <span className="rail-dot" aria-label="a plugin needs attention" />}
      </button>
      {open && <PluginsPanel client={client} plugins={plugins} onPanel={(next) => { setPanel(next); setOpen(false); }} onClose={() => setOpen(false)} />}
      {panel && <PanelFrame client={client} plugin={panel.plugin} panel={panel.id} title={panel.title} onClose={() => setPanel(null)} />}
    </div>
  );
}

function PluginsPanel({ client, plugins, onPanel, onClose }: { client: Client; plugins: PluginsView | null; onPanel: (panel: { plugin: string; id: string; title: string }) => void; onClose: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const run = (promise: Promise<unknown>) => { setProblem(null); void promise.catch((failure) => setProblem(why(failure))); };
  return (
    <div className="plugins-panel" role="dialog" aria-label="Plugins">
      <div className="plugins-head">
        <span>Plugins</span>
        <button type="button" className="plugins-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      {plugins?.host.problem && <p className="plugins-problem">{plugins.host.problem}</p>}
      {plugins?.secretsProblem && <p className="plugins-problem">{plugins.secretsProblem}</p>}
      {problem && <p className="plugins-problem" role="alert">{problem}</p>}
      {result && <p className="plugins-result" role="status">{result}</p>}
      {!plugins?.plugins.length && <p className="plugins-empty">No plugins yet. Ask the main bot or Maintainer for one, or to install one.</p>}
      <ul>
        {plugins?.plugins.map((plugin) => (
          <PluginItem key={plugin.name} plugin={plugin}
            onEnable={(enabled) => run(client.request({ type: "plugins.enable", name: plugin.name, enabled }))}
            onSetting={(key, value) => run(client.request({ type: "plugins.setting", name: plugin.name, key, value }))}
            onSecret={(key, value) => run(client.request({ type: "plugins.secret", name: plugin.name, key, value }))}
            onCommand={(id, title) => { setResult(null); run(client.request({ type: "plugins.command", id }).then((answer) => setResult(`${title}: ${answer.result === null || answer.result === undefined ? "done" : JSON.stringify(answer.result).slice(0, 200)}`))); }}
            onPanel={(id, title) => onPanel({ plugin: plugin.name, id, title })} />
        ))}
      </ul>
      {plugins?.broken.map((entry) => (
        <div key={entry.folder} className="plugins-broken" data-folder={entry.folder}>
          <div className="plugin-title">{entry.folder}</div>
          <div className="plugins-problem">Not loaded: {entry.problems.join("; ")}</div>
        </div>
      ))}
    </div>
  );
}

function PluginItem({ plugin, onEnable, onSetting, onSecret, onCommand, onPanel }: {
  plugin: PluginView;
  onEnable: (enabled: boolean) => void;
  onSetting: (key: string, value: boolean | number | string | null) => void;
  onSecret: (key: string, value: string | null) => void;
  onCommand: (id: string, title: string) => void;
  onPanel: (id: string, title: string) => void;
}) {
  return (
    <li className="plugin" data-plugin={plugin.name} data-enabled={plugin.enabled ? "1" : "0"}>
      <div className="plugin-row">
        <div className="plugin-title">{plugin.title} <span className="plugin-version">{plugin.version}</span></div>
        <label className="plugin-toggle">
          <input type="checkbox" checked={plugin.enabled} onChange={(event) => onEnable(event.target.checked)} aria-label={`${plugin.title} on`} />
          <span>{plugin.enabled ? "On" : "Off"}</span>
        </label>
      </div>
      {plugin.description && <div className="plugin-description">{plugin.description}</div>}
      {plugin.failure && <div className="plugins-problem">Turned off: {plugin.failure}</div>}
      <div className="plugin-meta">
        {[plugin.parts.join(", "), plugin.permissions.length ? `asks for: ${plugin.permissions.join(", ")}` : null, plugin.installedFrom ? `from ${plugin.installedFrom}` : null].filter(Boolean).join(" · ")}
      </div>
      {plugin.settings.map((setting) => (
        <div key={setting.key} className="plugin-setting" data-setting={setting.key}>
          <span className="plugin-setting-title">{setting.title}</span>
          {setting.secret ? <SecretField setting={setting} onSecret={(value) => onSecret(setting.key, value)} />
            : setting.type === "boolean" ? <input type="checkbox" checked={setting.value === true} onChange={(event) => onSetting(setting.key, event.target.checked)} aria-label={setting.title} />
            : setting.type === "enum" ? (
              <select value={String(setting.value ?? "")} onChange={(event) => onSetting(setting.key, event.target.value)} aria-label={setting.title}>
                {setting.options.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            ) : <TextField setting={setting} onSave={(value) => onSetting(setting.key, setting.type === "number" ? (value.trim() === "" ? null : Number(value)) : value)} />}
        </div>
      ))}
      {(plugin.commands.length > 0 || plugin.panels.length > 0) && (
        <div className="plugin-buttons">
          {plugin.commands.map((command) => (
            <button key={command.id} type="button" disabled={!plugin.enabled || !command.registered} title={command.registered ? command.id : "Its program part has not registered it"} onClick={() => onCommand(command.id, command.title)}>{command.title}</button>
          ))}
          {plugin.panels.map((panel) => <button key={panel.id} type="button" className="plugin-panel-button" onClick={() => onPanel(panel.id, panel.title)}>Open {panel.title}</button>)}
        </div>
      )}
    </li>
  );
}

function TextField({ setting, onSave }: { setting: PluginView["settings"][number]; onSave: (value: string) => void }) {
  const [text, setText] = useState(setting.value === null ? "" : String(setting.value));
  useEffect(() => { setText(setting.value === null ? "" : String(setting.value)); }, [setting.value]);
  const save = () => { if (text !== (setting.value === null ? "" : String(setting.value))) onSave(text); };
  return <input type={setting.type === "number" ? "number" : "text"} value={text} aria-label={setting.title} onChange={(event) => setText(event.target.value)} onBlur={save} onKeyDown={(event) => { if (event.key === "Enter") save(); }} />;
}

/** A secret: typed and sent once; the page never gets it back (only whether one is set). */
function SecretField({ setting, onSecret }: { setting: PluginView["settings"][number]; onSecret: (value: string | null) => void }) {
  const [text, setText] = useState("");
  return (
    <span className="plugin-secret">
      <input type="password" value={text} placeholder={setting.set ? "Set (hidden)" : "Not set"} aria-label={setting.title} autoComplete="off" onChange={(event) => setText(event.target.value)} />
      <button type="button" disabled={!text} onClick={() => { onSecret(text); setText(""); }}>Save</button>
      {setting.set && <button type="button" onClick={() => onSecret(null)}>Clear</button>}
    </span>
  );
}

/** A plugin's panel: its web part in a sandboxed frame; its `host.call`s go to its own program part. */
function PanelFrame({ client, plugin, panel, title, onClose }: { client: Client; plugin: string; panel: string; title: string; onClose: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    client.request({ type: "plugins.panel", name: plugin, panel })
      .then((part) => client.request({ type: "card.page", html: panelPage(plugin, panel, part.source, part.settings), panel: true }))
      .then((page) => { if (live) setUrl(page.url); }, (failure) => { if (live) setProblem(why(failure)); });
    return () => { live = false; };
  }, [client, plugin, panel]);
  const tokens = useRef({ left: 20, at: Date.now() });
  const paced = useCallback(() => {
    const now = Date.now();
    const bucket = tokens.current;
    bucket.left = Math.min(20, bucket.left + ((now - bucket.at) / 1000) * 10);
    bucket.at = now;
    if (bucket.left < 1) return false;
    bucket.left -= 1;
    return true;
  }, []);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only this panel's own frame; who it is comes from the frame, never the message.
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target) return;
      const message = event.data as { ccb?: unknown; id?: unknown; method?: unknown; params?: unknown; text?: unknown; message?: unknown } | null;
      if (!message || typeof message !== "object") return;
      const reply = (id: number, ok: boolean, value: unknown) => target.postMessage({ ccb: "reply", id, ok, value }, "*");
      if (message.ccb === "call" && typeof message.id === "number" && typeof message.method === "string") {
        const id = message.id;
        if (!paced()) { reply(id, false, "Too many calls; wait a moment."); return; }
        let params: unknown = null;
        try { params = JSON.parse(JSON.stringify(message.params ?? null)); } catch { reply(id, false, "Its parameters are not JSON."); return; }
        if (JSON.stringify(params).length > 1_000_000) { reply(id, false, "Its parameters are too big."); return; }
        client.request({ type: "plugins.call", name: plugin, method: message.method.slice(0, 200), params })
          .then((answer) => reply(id, true, answer.result), (failure) => reply(id, false, why(failure)));
      } else if (message.ccb === "command" && typeof message.id === "string" && message.id.startsWith(`${plugin}.`) && paced()) {
        void client.request({ type: "plugins.command", id: message.id.slice(0, 200) }).catch((failure) => setNote(why(failure)));
      } else if (message.ccb === "notify" && typeof message.text === "string") {
        setNote(message.text.slice(0, 400));
      } else if (message.ccb === "error" && typeof message.message === "string") {
        setNote(`The panel failed: ${message.message.slice(0, 400)}`);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [client, plugin, paced]);
  return (
    <div className="plugin-panel" role="dialog" aria-label={title}>
      <div className="plugins-head">
        <span>{title}</span>
        <button type="button" className="plugins-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      {problem && <p className="plugins-problem">{problem}</p>}
      {note && <p className="plugins-result" role="status">{note}</p>}
      {url && <iframe ref={frame} className="plugin-panel-frame" sandbox="allow-scripts" referrerPolicy="no-referrer" src={url} title={title} />}
    </div>
  );
}
