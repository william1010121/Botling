import { ShellOverlay } from "./ShellOverlay";
// The plugin library (1.x: Settings → Plugins): each plugin on or off, its settings (a secret is only
// ever sent, never shown back: the page knows whether it is set), its commands, and its panels, which
// open in a sandboxed frame (panel-page.ts). A small stand-in until 2.0 has 1.x's Settings window.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { isMaintainer, type BotView, type Command, type ComponentInfoView, type PluginStoreEntryView, type PluginStoreView, type PluginView, type PluginsView } from "../contract";
import { StoreList, usePluginStore } from "./PluginStore";
import { say } from "./shortcut-labels";
import type { Lang } from "../../../Web/src/i18n";
import { buildRequest, PLUGIN_STARTERS } from "./plugin-starters";
import { Client, RequestFailed } from "./client";
import { FrameBroker, registerPluginFrame } from "./frame-broker";
import { frameEvent, type BuiltinCommand, type FrameRequest } from "../../../Web/src/frame-protocol";
import { panelPage, type PanelFit } from "./panel-page";
import { frameNeedsReload, pluginStamp } from "./plugin-stamp";
import { pluginFrameHost, type PluginFrameHostDeps } from "./plugin-frame-host";
import { asksLine, grantTiersFor, windowGrantCommand, WINDOW_GRANT_WORDS, type WindowGrantTier } from "./plugin-grant";

const why = (failure: unknown) => (failure instanceof RequestFailed ? failure.error.message : String((failure as Error)?.message ?? failure));

export function PluginsButton({ client, plugins, bots, onAsked, lang = null, onShowMain, initialStore = null }: { client: Client; plugins: PluginsView | null; bots?: BotView[]; onAsked?: () => void; lang?: Lang | null;
  /** Shows the main bot's chat (where the install card is). */
  onShowMain?: () => void;
  /** The catalog's view before the core's answer (tests). */
  initialStore?: PluginStoreView | null }) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<{ plugin: string; id: string; title: string } | null>(null);
  const [store] = usePluginStore(client, initialStore);
  const broken = (plugins?.plugins.some((plugin) => plugin.failure) ?? false) || (plugins?.broken.length ?? 0) > 0;
  const updates = store?.updates ?? 0;
  return (
    <div className="rail-plugins">
      <button type="button" className={`rail-button${open ? " on" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        Plugins{broken && <span className="rail-dot" aria-label="a plugin needs attention" />}
        {updates > 0 && <span className="badge plugins-updates-badge" title={say(lang, "plugins.updatesCount", { n: updates })} aria-label={say(lang, "plugins.updatesCount", { n: updates })}>{updates}</span>}
      </button>
      {open && <ShellOverlay><PluginsPanel client={client} plugins={plugins} bots={bots} lang={lang} onPanel={(next) => { setPanel(next); setOpen(false); }} onClose={() => setOpen(false)} onAsked={() => { setOpen(false); onAsked?.(); }}
        {...(onShowMain ? { onShowMain: () => { setOpen(false); onShowMain(); } } : {})} /></ShellOverlay>}
      {panel && <ShellOverlay><PanelFrame client={client} plugin={panel.plugin} panel={panel.id} title={panel.title} onClose={() => setPanel(null)} /></ShellOverlay>}
    </div>
  );
}

export type PluginsTab = "installed" | "explore" | "updates";

export function PluginsPanel({ client, plugins, bots, onPanel, onClose, onAsked, onShowMain, embedded = false, lang = null, initialTab = "installed", initialStore = null }: { client: Client; plugins: PluginsView | null; bots?: BotView[]; onPanel: (panel: { plugin: string; id: string; title: string }) => void; onClose: () => void; onAsked?: () => void; onShowMain?: () => void; embedded?: boolean; lang?: Lang | null; initialTab?: PluginsTab; initialStore?: PluginStoreView | null }) {
  const maintainer = bots?.find(isMaintainer);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [tab, setTab] = useState<PluginsTab>(initialTab);
  const [store, setStore] = usePluginStore(client, initialStore);
  const run = (promise: Promise<unknown>) => { setProblem(null); void promise.catch((failure) => setProblem(why(failure))); };
  const catalog = new Map((store?.entries ?? []).map((entry) => [entry.name, entry]));
  const updates = store?.updates ?? 0;
  const tabs: { id: PluginsTab; label: string }[] = [
    { id: "installed", label: say(lang, "plugins.tab.installed") },
    { id: "explore", label: say(lang, "plugins.tab.explore") },
    { id: "updates", label: updates ? `${say(lang, "plugins.tab.updates")} (${updates})` : say(lang, "plugins.tab.updates") },
  ];
  return (
    <div className={embedded ? "plugins-list" : "plugins-panel"} role={embedded ? "region" : "dialog"} aria-label="Plugins">
      {!embedded && (
        <div className="plugins-head">
          <span>Plugins</span>
          <button type="button" className="plugins-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
      )}
      <div className="mw-tabs plugins-tabs" role="tablist" aria-label="Plugins">
        {tabs.map((one) => (
          <button key={one.id} type="button" role="tab" data-tab={one.id} aria-selected={tab === one.id} className={tab === one.id ? "on" : ""} onClick={() => { setProblem(null); setResult(null); setTab(one.id); }}>{one.label}</button>
        ))}
      </div>
      {problem && tab !== "installed" && <p className="plugins-problem" role="alert">{problem}</p>}
      {tab !== "installed" && <StoreList key={tab} client={client} store={store} setStore={setStore} lang={lang} only={tab === "updates" ? "updates" : "all"} onProblem={setProblem} {...(onShowMain ? { onShowCard: onShowMain } : {})} />}
      {tab === "installed" && <>
      {plugins?.host.problem && <p className="plugins-problem">{plugins.host.problem}</p>}
      {plugins?.secretsProblem && <p className="plugins-problem">{plugins.secretsProblem}</p>}
      {problem && <p className="plugins-problem" role="alert">{problem}</p>}
      {result && <p className="plugins-result" role="status">{result}</p>}
      {!plugins?.plugins.length && <p className="plugins-empty">No plugins yet. Ask the main bot or Maintainer for one, or to install one.</p>}
      <AskMaintainer onSend={(text) => { if (!maintainer) return; run(client.request({ type: "chat.send", botId: maintainer.id, text }).then(() => { setResult("Sent to Maintainer. It builds the plugin and checks it; you approve anything it needs."); onAsked?.(); })); }} />
      <ul>
        {plugins?.plugins.map((plugin) => (
          <PluginItem key={plugin.name} plugin={plugin} lang={lang} catalog={catalog.get(plugin.name) ?? null}
            onUpdate={() => { setProblem(null); void client.request({ type: "plugins.storeInstall", name: plugin.name, direct: true }).then((view) => { setStore(view); const status = view.entries.find((entry) => entry.name === plugin.name)?.status; if (status?.kind === "failed") setProblem(status.message); else if (status?.kind === "asking") setResult(status.message ?? say(lang, "plugins.asking")); else if (status?.kind === "installed") setResult(say(lang, "plugins.didInstall")); }, (failure) => setProblem(why(failure))); }}
            onRevert={() => run(client.request({ type: "plugins.revert", name: plugin.name }))}
            onRemove={() => run(client.request({ type: "plugins.remove", name: plugin.name }))}
            onEnable={(enabled) => run(client.request({ type: "plugins.enable", name: plugin.name, enabled }))}
            onSetting={(key, value) => run(client.request({ type: "plugins.setting", name: plugin.name, key, value }))}
            onSecret={(key, value) => run(client.request({ type: "plugins.secret", name: plugin.name, key, value }))}
            onCommand={(id, title) => { setResult(null); run(client.request({ type: "plugins.command", id }).then((answer) => setResult(`${title}: ${answer.result === null || answer.result === undefined ? "done" : JSON.stringify(answer.result).slice(0, 200)}`))); }}
            onPanel={(id, title) => onPanel({ plugin: plugin.name, id, title })}
            onGrant={(cmd) => client.request(cmd).then(() => {})} />
        ))}
      </ul>
      {plugins?.broken.map((entry) => (
        <div key={entry.folder} className="plugins-broken" data-folder={entry.folder}>
          <div className="plugin-title">{entry.folder}</div>
          <div className="plugins-problem">Not loaded: {entry.problems.join("; ")}</div>
        </div>
      ))}
      </>}
    </div>
  );
}

/** ADR-006 M5: describe a plugin (or start from a template) and hand it to Maintainer; it adds no new way to build. */
function AskMaintainer({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const request = buildRequest(text);
  return (
    <div className="plugins-ask">
      <div className="plugin-title">Ask Maintainer to build</div>
      <div className="plugins-starters">
        {PLUGIN_STARTERS.map((starter) => (
          <button key={starter.id} type="button" className="plugins-starter" data-starter={starter.id} onClick={() => setText(starter.text)}>{starter.title}</button>
        ))}
      </div>
      <textarea className="plugins-ask-text" rows={2} value={text} placeholder="Describe the plugin you want" aria-label="Describe the plugin you want" onChange={(event) => setText(event.target.value)} />
      <button type="button" className="plugins-ask-send" disabled={!request} onClick={() => { if (request) { onSend(request); setText(""); } }}>Ask Maintainer</button>
    </div>
  );
}

/**
 * Botling 3: approve a plugin from the window (an imported 2.x plugin waits at "nothing yet" until the user approves it).
 * The tiers go up to what it asks at the shown hash; [Allow] sends one `plugin.grant` at that hash with those asks. One tap
 * sends once (an in-flight guard in a ref, L-007); a refused grant shows why and can be tried again.
 */
function GrantChoice({ plugin, onGrant }: { plugin: PluginView; onGrant: (cmd: Extract<Command, { type: "plugin.grant" }>) => Promise<void> }) {
  const tiers = grantTiersFor(plugin);
  const current = plugin.grant !== undefined && plugin.grant !== "none" && tiers.includes(plugin.grant) ? plugin.grant : null;
  const [choice, setChoice] = useState<WindowGrantTier | null>(null);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [allowed, setAllowed] = useState<WindowGrantTier | null>(null);
  const granting = useRef(false);
  const shown = choice ?? current;
  const allow = () => {
    if (granting.current || shown === null || shown === current) return;
    const cmd = windowGrantCommand(plugin, shown);
    if (!cmd) return;
    granting.current = true;
    setSending(true);
    setProblem(null);
    setAllowed(null);
    void onGrant(cmd).then(
      () => { setAllowed(shown); setChoice(null); },
      (failure) => setProblem(why(failure)),
    ).finally(() => { granting.current = false; setSending(false); });
  };
  return (
    <div className="plugin-grant" role="group" aria-label={`Allow ${plugin.name} to`}>
      <div className="plugin-meta plugin-asks">{asksLine(plugin.asks!)}</div>
      {tiers.map((tier) => (
        <label key={tier} className="plugin-grant-option">
          <input type="radio" name={`grant-${plugin.name}`} value={tier} checked={shown === tier} disabled={sending}
            onChange={() => { setChoice(tier); setAllowed(null); setProblem(null); }} /> {WINDOW_GRANT_WORDS[tier]}
        </label>
      ))}
      <button type="button" className="plugin-grant-allow" disabled={sending || shown === null || shown === current} onClick={allow}>Allow</button>
      {allowed && <div className="plugin-meta plugin-grant-sent" role="status">Allowed: {WINDOW_GRANT_WORDS[allowed]}</div>}
      {problem && <div className="plugins-problem" role="alert">{problem}</div>}
    </div>
  );
}

const GRANT_WORDS: Record<NonNullable<PluginView["grant"]>, string> = {
  none: "nothing yet",
  read: "Read only",
  request: "Send what it asks for",
  write: "Change its own data on the server",
};

function PluginItem({ plugin, lang, catalog, onUpdate, onRevert, onRemove, onEnable, onSetting, onSecret, onCommand, onPanel, onGrant }: {
  plugin: PluginView;
  lang: Lang | null;
  /** The same plugin in the public catalog, if it is there. */
  catalog: PluginStoreEntryView | null;
  onUpdate: () => void;
  onRevert: () => void;
  onRemove: () => void;
  onEnable: (enabled: boolean) => void;
  onSetting: (key: string, value: boolean | number | string | null) => void;
  onSecret: (key: string, value: string | null) => void;
  onCommand: (id: string, title: string) => void;
  onPanel: (id: string, title: string) => void;
  /** Botling 3: sends the window's `plugin.grant` for this plugin (settles when the owner answers). */
  onGrant: (cmd: Extract<Command, { type: "plugin.grant" }>) => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const busy = catalog?.status?.kind === "checking" || catalog?.status?.kind === "asking";
  const update = catalog?.state === "update" && catalog.installedVersion === plugin.version;
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
      {plugin.skipped?.length ? <div className="plugins-problem plugins-skipped">Skipped (this Botling does not know or cannot read these; the rest loads): {plugin.skipped.join("; ")}</div> : null}
      {plugin.builtIn && <div className="plugin-meta">Built into Botling{plugin.ignoredLibraryVersion !== undefined ? " (in use)" : ""}</div>}
      {plugin.grant !== undefined && (
        <>
          <div className="plugin-meta">Allowed on this machine: {GRANT_WORDS[plugin.grant]}</div>
          {!plugin.builtIn && <div className="plugin-meta">To change it: botlingd plugins grant {plugin.name} --tier read|request|write</div>}
        </>
      )}
      {/* A new running hash starts a fresh choice (the old one was for code no longer shown). */}
      {plugin.asks && grantTiersFor(plugin).length > 0 && <GrantChoice key={plugin.asks.codeHash} plugin={plugin} onGrant={onGrant} />}
      {/* Which copy runs when the library has one too (core/plugins/versions.ts): the library's at the built-in's version or newer. */}
      {plugin.ignoredLibraryVersion !== undefined && <div className="plugin-meta plugin-copy-ignored">Your plugin library's copy ({plugin.ignoredLibraryVersion}) is older and is ignored</div>}
      {plugin.replacesBuiltIn !== undefined && <div className="plugin-meta plugin-copy-library">Your plugin library's copy (in use) replaces the built-in {plugin.replacesBuiltIn}</div>}
      {plugin.installedFrom && <div className="plugin-meta">from {plugin.installedFrom}</div>}
      {catalog?.state === "devCopy" && <div className="plugin-meta plugin-dev-copy">{say(lang, "plugins.devCopy", { version: catalog.version })}</div>}
      {(update || plugin.revertTo !== undefined || plugin.removable) && !asking && (
        <div className="plugin-buttons plugin-manage">
          {update && <button type="button" className="plugin-update" disabled={busy} onClick={onUpdate}>{catalog.status?.kind === "checking" ? say(lang, "plugins.checking") : say(lang, "plugins.update", { version: catalog.version })}</button>}
          {plugin.revertTo !== undefined && <button type="button" className="plugin-revert" disabled={busy} onClick={onRevert}>{say(lang, "plugins.revert", { version: plugin.revertTo })}</button>}
          {plugin.removable && <button type="button" className="plugin-remove" disabled={busy} onClick={() => setAsking(true)}>{say(lang, "plugins.remove")}</button>}
        </div>
      )}
      {asking && (
        <div className="plugin-row plugin-remove-ask" role="alertdialog" aria-label={say(lang, "plugins.removeAsk", { name: plugin.title })}>
          <span className="plugins-problem">{say(lang, "plugins.removeAsk", { name: plugin.title })}</span>
          <span className="plugin-buttons">
            <button type="button" className="plugin-remove-yes" onClick={() => { setAsking(false); onRemove(); }}>{say(lang, "plugins.removeYes")}</button>
            <button type="button" onClick={() => setAsking(false)}>{say(lang, "plugins.cancel")}</button>
          </span>
        </div>
      )}
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
  // An update of the plugin (a new version in `plugins.updated`) loads its web part again, in the same frame slot; `built` is what this frame came from.
  const [reloads, setReloads] = useState(0);
  const built = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    // The stamp is read before the source: a version that lands between the two only causes one more reload.
    client.request({ type: "plugins.list" })
      .then((list) => { if (live) built.current = pluginStamp(list.plugins.find((entry) => entry.name === plugin)); }, () => { /* no stamp: this frame never reloads */ });
    client.request({ type: "plugins.panel", name: plugin, panel })
      .then((part) => client.request({ type: "card.page", html: panelPage(plugin, panel, part.source, part.settings, fit, context), panel: true }))
      .then((page) => { if (live) { setProblem(null); setUrl(page.url); } }, (failure) => { if (live) setProblem(why(failure)); });
    return () => { live = false; };
  }, [client, plugin, panel, reloads]);
  useEffect(() => client.onEvent(({ event }) => {
    if (event.type !== "plugins.updated" || !frameNeedsReload(built.current, event.plugins.plugins, plugin)) return;
    built.current = pluginStamp(event.plugins.plugins.find((entry) => entry.name === plugin));
    setReloads((count) => count + 1);
  }), [client, plugin]);
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
      // A main-area tab's (the Note's) bot: the one input box it may quote into (`ccb.composer.insertQuote`).
      ...(botKey ? { bot: botKey } : {}),
    });
  }, [client, plugin, url, runsBuiltins, !!fit, hasRate, botKey]);
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
export function MainTabFrame({ client, plugin, view, title, onBuiltin, botId, overlay, ...services }: { client: Client; plugin: string; view: string; title: string; onBuiltin: BuiltinRunner; botId?: string;
  /** Drawn over the tab's frame (the Note's bot bubble, NoteDock.tsx). */
  overlay?: ReactNode } & FrameServices) {
  const { frame, url, problem, note } = usePluginFrame(client, plugin, view, onBuiltin, services, undefined, botId ? { botId } : undefined);
  return (
    <div className="main-tab" role="region" aria-label={title} data-plugin={plugin}>
      {problem && <p className="plugins-problem">{problem}</p>}
      {note && <p className="plugins-result" role="status">{note}</p>}
      {url && <iframe ref={frame} className="main-tab-frame" sandbox="allow-scripts" referrerPolicy="no-referrer" src={url} title={title} />}
      {overlay}
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
