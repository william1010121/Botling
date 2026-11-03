import { ShellOverlay } from "./ShellOverlay";
// The plugin library (1.x: Settings → Plugins): each plugin on or off, its settings (a secret is only
// ever sent, never shown back: the page knows whether it is set), its commands, and its panels, which
// open in a sandboxed frame (panel-page.ts). A small stand-in until 2.0 has 1.x's Settings window.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { BotView, ComponentInfoView, PluginView, PluginsView } from "../contract";
import { Client, RequestFailed } from "./client";
import { FrameBroker, registerPluginFrame } from "./frame-broker";
import { frameEvent, type BuiltinCommand, type FrameRequest } from "../../../Web/src/frame-protocol";
import { panelPage, type PanelFit } from "./panel-page";
import { pluginFrameHost, type PluginFrameHostDeps } from "./plugin-frame-host";

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
      {open && <ShellOverlay><PluginsPanel client={client} plugins={plugins} onPanel={(next) => { setPanel(next); setOpen(false); }} onClose={() => setOpen(false)} /></ShellOverlay>}
      {panel && <ShellOverlay><PanelFrame client={client} plugin={panel.plugin} panel={panel.id} title={panel.title} onClose={() => setPanel(null)} /></ShellOverlay>}
    </div>
  );
}

export function PluginsPanel({ client, plugins, onPanel, onClose, embedded = false }: { client: Client; plugins: PluginsView | null; onPanel: (panel: { plugin: string; id: string; title: string }) => void; onClose: () => void; embedded?: boolean }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const run = (promise: Promise<unknown>) => { setProblem(null); void promise.catch((failure) => setProblem(why(failure))); };
  return (
    <div className={embedded ? "plugins-list" : "plugins-panel"} role={embedded ? "region" : "dialog"} aria-label="Plugins">
      {!embedded && (
        <div className="plugins-head">
          <span>Plugins</span>
          <button type="button" className="plugins-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
      )}
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
      {plugin.builtIn && <div className="plugin-meta">Built into Botling</div>}
      {plugin.installedFrom && <div className="plugin-meta">from {plugin.installedFrom}</div>}
      {/* A built-in plugin's settings set on the Settings page (`hidden`) are not repeated here. */}
      {plugin.settings.filter((setting) => !setting.hidden).map((setting) => (
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

// The app page's plugin frames. Its other frames (the chat page) have listeners of their own.
let brokerForPanels: FrameBroker | null = null;
const panelFrames = () => (brokerForPanels ??= new FrameBroker(window, { ignore: () => true, name: "panel broker" }));

/** Runs Botling's own commands a plugin frame asks for (botling.openChat / openResult); without it they are refused. */
export type BuiltinRunner = (plugin: string, command: BuiltinCommand) => void;

/** What a plugin frame's tiles and approval asks need of this page (plugin-frame-host.ts): the library, the bots, its own ApprovalSheet. */
export interface FrameServices { components?: Record<string, ComponentInfoView>; bots?: BotView[]; ask?: PluginFrameHostDeps["ask"] }

/**
 * A plugin view's sandboxed frame: its page made from the web part, its calls to its own program part, its commands,
 * its tiles and approval asks (answered here; only this page's ApprovalSheet allows).
 */
/** What only some frames use: a panel under the chat asks to be shown or hidden, hands a key it did not use to the page, and may call more often (it streams). */
export interface FrameExtras {
  onReady?(): void;
  onPanel?(visible: boolean): void;
  onKey?(key: Extract<FrameRequest, { ccb: "key" }>): void;
  rate?: { burst: number; perSecond: number };
}

function usePluginFrame(client: Client, plugin: string, panel: string, onBuiltin?: BuiltinRunner, services: FrameServices = {}, fit?: PanelFit, context?: Record<string, string>, extras: FrameExtras = {}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [height, setHeight] = useState(0);
  // Read through a ref, so a new handler does not register the frame again.
  const builtin = useRef(onBuiltin);
  builtin.current = onBuiltin;
  const runsBuiltins = !!onBuiltin;
  const now = useRef(services);
  now.current = services;
  const more = useRef(extras);
  more.current = extras;
  const hasRate = !!extras.rate;
  const botKey = context?.botId;
  // What the plugin's program part pushes (`ui.emit`) goes to its frames: every one, or those of the bot it names.
  useEffect(() => {
    if (!url) return;
    return client.onEvent(({ event }) => {
      if (event.type !== "plugins.emit" || event.plugin !== plugin) return;
      if (event.forBot !== undefined && event.forBot !== botKey) return;
      frame.current?.contentWindow?.postMessage(frameEvent(event.name, event.data), "*");
    });
  }, [client, plugin, url, botKey]);
  useEffect(() => {
    let live = true;
    client.request({ type: "plugins.panel", name: plugin, panel })
      .then((part) => client.request({ type: "card.page", html: panelPage(plugin, panel, part.source, part.settings, fit, context), panel: true }))
      .then((page) => { if (live) setUrl(page.url); }, (failure) => { if (live) setProblem(why(failure)); });
    return () => { live = false; };
  }, [client, plugin, panel]);
  useEffect(() => {
    const element = frame.current;
    if (!url || !element) return;
    return registerPluginFrame(panelFrames(), {
      ...pluginFrameHost({
        client,
        components: () => now.current.components ?? {},
        bots: () => now.current.bots ?? [],
        // No sheet on this page: nothing is allowed.
        ask: (view, approve, done) => (now.current.ask ? now.current.ask(view, approve, done) : done(false)),
      }),
      ...(runsBuiltins ? { builtin: (name: string, command: BuiltinCommand) => builtin.current?.(name, command) } : {}),
    }, {
      frame: element,
      plugin,
      onNotice: (text) => setNote(text),
      onError: (message) => setNote(`The panel failed: ${message}`),
      ...(fit ? { onResize: setHeight } : {}),
      onReady: () => more.current.onReady?.(),
      onPanel: (visible) => more.current.onPanel?.(visible),
      onKey: (key) => more.current.onKey?.(key),
      ...(hasRate ? { rate: more.current.rate } : {}),
    });
  }, [client, plugin, url, runsBuiltins, !!fit, hasRate]);
  return { frame, url, problem, note, height };
}

/** A plugin's panel: its web part in a sandboxed frame; its `host.call`s go to its own program part. */
export function PanelFrame({ client, plugin, panel, title, onClose, onBuiltin, ...services }: { client: Client; plugin: string; panel: string; title: string; onClose: () => void; onBuiltin?: BuiltinRunner } & FrameServices) {
  const { frame, url, problem, note } = usePluginFrame(client, plugin, panel, onBuiltin, services);
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

/** A plugin's main-area tab (`where: "mainTab"`, plan W2): the same frame, in the chat's place. */
export function MainTabFrame({ client, plugin, view, title, onBuiltin, botId, ...services }: { client: Client; plugin: string; view: string; title: string; onBuiltin: BuiltinRunner; botId?: string } & FrameServices) {
  const { frame, url, problem, note } = usePluginFrame(client, plugin, view, onBuiltin, services, undefined, botId ? { botId } : undefined);
  return (
    <div className="main-tab" role="region" aria-label={title} data-plugin={plugin}>
      {problem && <p className="plugins-problem">{problem}</p>}
      {note && <p className="plugins-result" role="status">{note}</p>}
      {url && <iframe ref={frame} className="main-tab-frame" sandbox="allow-scripts" referrerPolicy="no-referrer" src={url} title={title} />}
    </div>
  );
}

/**
 * A plugin's block inside the app page's own surface (`settings.section`, `quickSettings`): the same sandboxed frame,
 * as tall as its content (the frame says so) and without a border or background, so it reads as part of the page.
 */
export function SlotFrame({ client, plugin, view, title, fontSize, onBuiltin, botId, ...services }: { client: Client; plugin: string; view: string; title: string; fontSize: number; onBuiltin?: BuiltinRunner; botId?: string } & FrameServices) {
  const { frame, url, problem, note, height } = usePluginFrame(client, plugin, view, onBuiltin, services, { fontSize }, botId ? { botId } : undefined);
  return (
    <div className="plugin-slot" data-plugin={plugin} data-view={view}>
      {problem && <p className="plugins-problem">{problem}</p>}
      {note && <p className="plugins-result" role="status">{note}</p>}
      {url && <iframe ref={frame} className="plugin-slot-frame" sandbox="allow-scripts" referrerPolicy="no-referrer" src={url} title={title} style={{ height }} />}
    </div>
  );
}

/**
 * A plugin's panel under the chat (`where: "bottomPanel"`): the same frame, one per bot, kept alive while hidden. The page
 * (BottomPanels.tsx) lays it out; the frame asks to be shown or hidden and hears when it is, and when its toggle command ran.
 */
export const BottomPanelFrame = forwardRef<HTMLIFrameElement | null, { client: Client; plugin: string; view: string; title: string; botId: string; onBuiltin: BuiltinRunner; extras: FrameExtras } & FrameServices>(
  function BottomPanelFrame({ client, plugin, view, title, botId, onBuiltin, extras, ...services }, ref) {
    const { frame, url, problem, note } = usePluginFrame(client, plugin, view, onBuiltin, services, undefined, { botId }, extras);
    useImperativeHandle(ref, () => frame.current as HTMLIFrameElement, [frame, url]);
    return (
      <div className="bottom-panel-body" data-plugin={plugin} data-view={view}>
        {problem && <p className="plugins-problem">{problem}</p>}
        {note && <p className="plugins-result" role="status">{note}</p>}
        {url && <iframe ref={frame} className="bottom-panel-frame" sandbox="allow-scripts" referrerPolicy="no-referrer" src={url} title={title} />}
      </div>
    );
  });
