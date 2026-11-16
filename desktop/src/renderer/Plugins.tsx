import { ShellOverlay } from "./ShellOverlay";
// The plugin library (1.x: Settings → Plugins), as a list on the left and the chosen plugin on the right: each plugin on or
// off, its settings (a secret is only ever sent, never shown back: the page knows whether it is set), its commands, and its
// panels, which open in a sandboxed frame (panel-page.ts). Three tabs: Installed, Store (the public catalog, PluginStore.tsx)
// and Dependencies (the read-only board of botling.deps). A plugin that still waits for the user's Allow comes first
// everywhere: a count on the Plugins entry, an orange group and row, and an Allow button at the top of its detail.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { isMaintainer, type BotView, type Command, type ComponentInfoView, type PluginStoreEntryView, type PluginStoreView, type PluginView, type PluginsView } from "../contract";
import { permissionWords, StoreList, usePluginStore } from "./PluginStore";
import { say } from "./shortcut-labels";
import type { Lang } from "../../../Web/src/i18n";
import { buildRequest, PLUGIN_STARTERS } from "./plugin-starters";
import { Client, RequestFailed } from "./client";
import { FrameBroker, registerPluginFrame } from "./frame-broker";
import { frameEvent, type BuiltinCommand, type FrameRequest } from "../../../Web/src/frame-protocol";
import { panelPage, type PanelFit } from "./panel-page";
import { frameNeedsReload, pluginStamp } from "./plugin-stamp";
import { pluginFrameHost, type PluginFrameHostDeps } from "./plugin-frame-host";
import { asksLine, canInstall, installCommand, waitingForAllow } from "./plugin-grant";

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
  const waiting = waitingForAllow(plugins?.plugins).length;
  return (
    <div className="rail-plugins">
      <button type="button" className={`rail-button${open ? " on" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        Plugins{broken && <span className="rail-dot" aria-label="a plugin needs attention" />}
        {waiting > 0 && <span className="badge waiting plugins-allow-badge" title={say(lang, "plugins.allowCount", { n: waiting })} aria-label={say(lang, "plugins.allowCount", { n: waiting })}>{waiting}</span>}
        {updates > 0 && <span className="badge plugins-updates-badge" title={say(lang, "plugins.updatesCount", { n: updates })} aria-label={say(lang, "plugins.updatesCount", { n: updates })}>{updates}</span>}
      </button>
      {open && <ShellOverlay><PluginsPanel client={client} plugins={plugins} bots={bots} lang={lang} onPanel={(next) => { setPanel(next); setOpen(false); }} onClose={() => setOpen(false)} onAsked={() => { setOpen(false); onAsked?.(); }}
        {...(onShowMain ? { onShowMain: () => { setOpen(false); onShowMain(); } } : {})} /></ShellOverlay>}
      {panel && <ShellOverlay><PanelFrame client={client} plugin={panel.plugin} panel={panel.id} title={panel.title} onClose={() => setPanel(null)} /></ShellOverlay>}
    </div>
  );
}

export type PluginsTab = "installed" | "explore" | "deps";

const withName = (names: ReadonlySet<string>, name: string, present: boolean): Set<string> => { const next = new Set(names); if (present) next.add(name); else next.delete(name); return next; };

export function PluginsPanel({ client, plugins, bots, onPanel, onClose, onAsked, onShowMain, embedded = false, lang = null, initialTab = "installed", initialStore = null }: { client: Client; plugins: PluginsView | null; bots?: BotView[]; onPanel: (panel: { plugin: string; id: string; title: string }) => void; onClose: () => void; onAsked?: () => void; onShowMain?: () => void; embedded?: boolean; lang?: Lang | null; initialTab?: PluginsTab; initialStore?: PluginStoreView | null }) {
  const maintainer = bots?.find(isMaintainer);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [tab, setTab] = useState<PluginsTab>(initialTab);
  const [store, setStore] = usePluginStore(client, initialStore);
  const [picked, setPicked] = useState<string | null>(null);
  const [card, setCard] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Updates started from here: those running, and those done (so "Updated" stays in the row after the list moves on).
  const [updating, setUpdating] = useState<ReadonlySet<string>>(new Set());
  const [updated, setUpdated] = useState<ReadonlySet<string>>(new Set());
  const updateRuns = useRef(new Set<string>());
  const w = (key: Parameters<typeof say>[1], values?: Record<string, string | number>) => say(lang, key, values);
  const run = (promise: Promise<unknown>) => { setProblem(null); void promise.catch((failure) => setProblem(why(failure))); };
  const catalog = new Map((store?.entries ?? []).map((entry) => [entry.name, entry]));
  const updates = store?.updates ?? 0;
  const list = plugins?.plugins ?? [];
  const waiting = waitingForAllow(list);
  const hasUpdate = (plugin: PluginView) => { const entry = catalog.get(plugin.name); return entry?.state === "update" && entry.installedVersion === plugin.version; };
  // The toast under the page fades after a few seconds.
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), 6_000);
    return () => clearTimeout(timer);
  }, [result]);

  // The list: what waits for Allow first, then what has a new version, then the rest (yours, then built in).
  const words = query.trim().toLowerCase();
  const shown = list.filter((plugin) => !words || `${plugin.title} ${plugin.name} ${plugin.description ?? ""}`.toLowerCase().includes(words));
  const waits = new Set(waiting.map((plugin) => plugin.name));
  const rest = (plugin: PluginView) => !waits.has(plugin.name) && !hasUpdate(plugin);
  const groups = ([
    { id: "allow", key: "plugins.group.allow", items: shown.filter((plugin) => waits.has(plugin.name)) },
    { id: "update", key: "plugins.group.update", items: shown.filter((plugin) => !waits.has(plugin.name) && hasUpdate(plugin)) },
    { id: "mine", key: "plugins.group.mine", items: shown.filter((plugin) => rest(plugin) && !plugin.builtIn) },
    { id: "builtIn", key: "plugins.group.builtIn", items: shown.filter((plugin) => rest(plugin) && plugin.builtIn) },
  ] as const).filter((group) => group.items.length > 0).map((group) => ({ id: group.id, items: group.items, title: w(group.key, { n: group.items.length }) }));
  // Open on what needs the user: a plugin that waits for Allow, then one that failed, then one with a new version.
  const selected = list.find((plugin) => plugin.name === picked) ?? list.find(canInstall) ?? list.find((plugin) => plugin.failure) ?? list.find(hasUpdate) ?? list[0] ?? null;
  const cardPlugin = card ? list.find((plugin) => plugin.name === card) ?? null : null;

  const update = (plugin: PluginView) => {
    // A ref, not state: two taps in one batch both see the old state (L-007).
    if (updateRuns.current.has(plugin.name)) return;
    updateRuns.current.add(plugin.name);
    setUpdating((names) => withName(names, plugin.name, true));
    setProblem(null);
    void client.request({ type: "plugins.storeInstall", name: plugin.name, direct: true }).then((view) => {
      setStore(view);
      const status = view.entries.find((entry) => entry.name === plugin.name)?.status;
      if (status?.kind === "failed") setProblem(status.message);
      else if (status?.kind === "asking") setResult(w("plugins.asking"));
      else if (status?.kind === "installed") { setUpdated((names) => withName(names, plugin.name, true)); setResult(w("plugins.updatedToast", { name: plugin.title })); }
    }, (failure) => setProblem(why(failure))).finally(() => { updateRuns.current.delete(plugin.name); setUpdating((names) => withName(names, plugin.name, false)); });
  };
  const showWaiting = () => { const first = waiting[0]; if (!first) return; setProblem(null); setQuery(""); setPicked(first.name); setTab("installed"); };
  const tabs: { id: PluginsTab; label: string; allow?: number; news?: number }[] = [
    { id: "installed", label: w("plugins.tab.installed"), allow: waiting.length, news: updates },
    { id: "explore", label: w("plugins.tab.explore") },
    { id: "deps", label: w("plugins.tab.deps") },
  ];
  return (
    <div className={`${embedded ? "plugins-list" : "plugins-panel"} plugins-v2`} role={embedded ? "region" : "dialog"} aria-label="Plugins">
      {!embedded && (
        <div className="plugins-head">
          <span>Plugins</span>
          <button type="button" className="plugins-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
      )}
      {waiting.length > 0 && (
        <div className="plugins-banner" role="status" data-testid="allow-banner">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4.5" /><path d="M12 17.5v.01" /></svg>
          <span className="plugins-banner-text">{w("plugins.banner", { n: waiting.length })}: <b>{waiting.map((plugin) => plugin.title).join(", ")}</b></span>
          <button type="button" className="plugins-banner-show" onClick={showWaiting}>{w("plugins.bannerReview")}</button>
        </div>
      )}
      <div className="plugins-bar">
        <div className="mw-tabs plugins-tabs" role="tablist" aria-label="Plugins">
          {tabs.map((one) => (
            <button key={one.id} type="button" role="tab" data-tab={one.id} aria-selected={tab === one.id} className={tab === one.id ? "on" : ""} onClick={() => { setProblem(null); setResult(null); setTab(one.id); }}>
              {one.label}
              {one.allow ? <span className="badge waiting" aria-label={w("plugins.allowCount", { n: one.allow })}>{one.allow}</span> : null}
              {one.news ? <span className="badge" aria-label={w("plugins.updatesCount", { n: one.news })}>{one.news}</span> : null}
            </button>
          ))}
        </div>
        <span className="plugins-summary">{w("plugins.summary", { n: list.length, on: list.filter((plugin) => plugin.enabled).length })}</span>
      </div>
      {problem && <p className="plugins-problem plugins-page-problem" role="alert">{problem}</p>}
      {tab === "explore" && <StoreList key="explore" client={client} store={store} setStore={setStore} lang={lang} onProblem={setProblem} {...(onShowMain ? { onShowCard: onShowMain } : {})} />}
      {tab === "deps" && <DepsTab client={client} plugins={plugins} lang={lang} />}
      {tab === "installed" && (
        <div className="plugins-split">
          <div className="plugins-side">
            {plugins?.host.problem && <p className="plugins-problem">{plugins.host.problem}</p>}
            {plugins?.secretsProblem && <p className="plugins-problem">{plugins.secretsProblem}</p>}
            <label className="plugins-search">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
              <input type="search" aria-label={w("plugins.search")} placeholder={w("plugins.search")} value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <div className="plugins-scroll">
              {!list.length && <p className="plugins-empty">No plugins yet. Ask the main bot or Maintainer for one, or to install one.</p>}
              {list.length > 0 && !shown.length && <p className="plugins-empty">{w("plugins.noMatch")}</p>}
              {groups.map((group) => (
                <div key={group.id} className="plugins-group" data-group={group.id} role="group" aria-label={group.title}>
                  <div className={`plugins-group-title${group.id === "allow" ? " allow" : ""}`}>{group.title}</div>
                  <ul>
                    {group.items.map((plugin) => (
                      <PluginRow key={plugin.name} plugin={plugin} lang={lang} catalog={catalog.get(plugin.name) ?? null} selected={selected?.name === plugin.name}
                        updating={updating.has(plugin.name) || catalog.get(plugin.name)?.status?.kind === "checking"} updated={updated.has(plugin.name)}
                        onPick={() => setPicked(plugin.name)} onAllow={() => { setPicked(plugin.name); setCard(plugin.name); }} onUpdate={() => update(plugin)}
                        onEnable={(enabled) => run(client.request({ type: "plugins.enable", name: plugin.name, enabled }))} />
                    ))}
                  </ul>
                </div>
              ))}
              {plugins?.broken.map((entry) => (
                <div key={entry.folder} className="plugins-broken" data-folder={entry.folder}>
                  <div className="plugin-title">{entry.folder}</div>
                  <div className="plugins-problem">Not loaded: {entry.problems.join("; ")}</div>
                </div>
              ))}
              <AskMaintainer lang={lang} onSend={(text) => { if (!maintainer) return; run(client.request({ type: "chat.send", botId: maintainer.id, text }).then(() => { setResult("Sent to Maintainer. It builds the plugin and checks it; you approve anything it needs."); onAsked?.(); })); }} />
            </div>
          </div>
          <div className="plugins-detail-pane">
            {selected && (
              <PluginDetail key={selected.name} plugin={selected} lang={lang} catalog={catalog.get(selected.name) ?? null}
                updating={updating.has(selected.name) || catalog.get(selected.name)?.status?.kind === "checking"} updated={updated.has(selected.name)}
                busy={catalog.get(selected.name)?.status?.kind === "checking" || catalog.get(selected.name)?.status?.kind === "asking"}
                onAllow={() => setCard(selected.name)} onUpdate={() => update(selected)}
                onRemove={() => run(client.request({ type: "plugins.remove", name: selected.name }))}
                onEnable={(enabled) => run(client.request({ type: "plugins.enable", name: selected.name, enabled }))}
                onSetting={(key, value) => run(client.request({ type: "plugins.setting", name: selected.name, key, value }))}
                onSecret={(key, value) => run(client.request({ type: "plugins.secret", name: selected.name, key, value }))}
                onCommand={(id, title) => { setResult(null); run(client.request({ type: "plugins.command", id }).then((answer) => setResult(`${title}: ${answer.result === null || answer.result === undefined ? "done" : JSON.stringify(answer.result).slice(0, 200)}`))); }}
                onPanel={(id, title) => onPanel({ plugin: selected.name, id, title })} />
            )}
          </div>
        </div>
      )}
      {result && <div className="plugins-toast" role="status"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg><span className="plugins-result">{result}</span></div>}
      {cardPlugin && (
        <ShellOverlay>
          <InstallCard key={cardPlugin.asks?.codeHash ?? cardPlugin.name} plugin={cardPlugin} lang={lang} onClose={() => setCard(null)} onGrant={(cmd) => client.request(cmd).then(() => {})} />
        </ShellOverlay>
      )}
    </div>
  );
}

/** ADR-006 M5: describe a plugin (or start from a template) and hand it to Maintainer; it adds no new way to build. */
function AskMaintainer({ onSend, lang }: { onSend: (text: string) => void; lang: Lang | null }) {
  const [text, setText] = useState("");
  const request = buildRequest(text);
  return (
    <details className="plugins-ask">
      <summary className="plugin-title">{say(lang, "plugins.askBuild")}</summary>
      <div className="plugins-starters">
        {PLUGIN_STARTERS.map((starter) => (
          <button key={starter.id} type="button" className="plugins-starter" data-starter={starter.id} onClick={() => setText(starter.text)}>{starter.title}</button>
        ))}
      </div>
      <textarea className="plugins-ask-text" rows={2} value={text} placeholder="Describe the plugin you want" aria-label="Describe the plugin you want" onChange={(event) => setText(event.target.value)} />
      <button type="button" className="plugins-ask-send" disabled={!request} onClick={() => { if (request) { onSend(request); setText(""); } }}>Ask Maintainer</button>
    </details>
  );
}

/** The first letter of a plugin's name, drawn in its tile. */
const letterOf = (title: string) => Array.from(title.trim())[0]?.toUpperCase() ?? "?";

/** One line of the plugin list: pick it, Allow / Update it, switch it on or off. */
function PluginRow({ plugin, lang, catalog, selected, updating, updated, onPick, onAllow, onUpdate, onEnable }: {
  plugin: PluginView; lang: Lang | null; catalog: PluginStoreEntryView | null; selected: boolean; updating: boolean; updated: boolean;
  onPick: () => void; onAllow: () => void; onUpdate: () => void; onEnable: (enabled: boolean) => void;
}) {
  const w = (key: Parameters<typeof say>[1], values?: Record<string, string | number>) => say(lang, key, values);
  const needsAllow = canInstall(plugin);
  const update = catalog?.state === "update" && catalog.installedVersion === plugin.version;
  let sub = needsAllow ? w("plugins.needsAllowTitle") : update ? `${plugin.version} → ${catalog!.version}` : `${plugin.version} · ${plugin.builtIn ? w("plugins.kindBuiltIn") : w("plugins.kindInstalled")}`;
  if (!plugin.enabled) sub += ` · ${w("plugins.off")}`;
  return (
    <li className={`plugin plugin-item${selected ? " selected" : ""}${needsAllow ? " needs-allow" : ""}`} data-plugin={plugin.name} data-enabled={plugin.enabled ? "1" : "0"}>
      <button type="button" className="plugin-pick" aria-current={selected ? "true" : undefined} onClick={onPick}>
        <span className={`plugin-tile${plugin.builtIn ? " built-in" : ""}${needsAllow ? " allow" : ""}`} aria-hidden="true">{letterOf(plugin.title)}</span>
        <span className="plugin-names">
          <span className="plugin-title">{plugin.title}</span>
          <span className={`plugin-sub${needsAllow ? " allow" : ""}`}>{sub}</span>
        </span>
      </button>
      {needsAllow && <button type="button" className="plugin-allow-open" onClick={onAllow}>{w("plugins.allow")}</button>}
      {!needsAllow && update && !updating && !updated && <button type="button" className="plugin-update" onClick={onUpdate}>{w("plugins.updateShort")}</button>}
      {updating && <span className="plugin-spinner" role="status" aria-label={w("plugins.updating")} />}
      {updated && !updating && <span className="plugin-updated">{w("plugins.updated")}</span>}
      <input type="checkbox" role="switch" className="plugin-switch" checked={plugin.enabled} onChange={(event) => onEnable(event.target.checked)} aria-label={`${plugin.title} on`} />
    </li>
  );
}

/**
 * Botling 3: the install card, drawn over Settings. A plugin that is not installed yet (a bot wrote it, or a folder was copied in) waits at
 * "not installed" until the user taps [Install and allow]: one `plugin.grant` at the shown hash with the shown asks. After it the
 * plugin and its new versions are fully allowed. One tap sends once (an in-flight guard in a ref, L-007); a refused
 * install shows why and can be tried again.
 */
function InstallCard({ plugin, lang, onClose, onGrant }: { plugin: PluginView; lang: Lang | null; onClose: () => void; onGrant: (cmd: Extract<Command, { type: "plugin.grant" }>) => Promise<void> }) {
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);
  const installing = useRef(false);
  const w = (key: Parameters<typeof say>[1], values?: Record<string, string | number>) => say(lang, key, values);
  const install = () => {
    if (installing.current) return;
    const cmd = installCommand(plugin);
    if (!cmd) return;
    installing.current = true;
    setSending(true);
    setProblem(null);
    void onGrant(cmd).then(
      () => setInstalled(true),
      (failure) => setProblem(why(failure)),
    ).finally(() => { installing.current = false; setSending(false); });
  };
  const done = installed || !canInstall(plugin);
  const can = permissionWords(lang, plugin.permissions);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="plugin-card-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="plugin-grant plugin-install-card" role="dialog" aria-modal="true" aria-label={`Install ${plugin.name}`}>
        <div className="plugin-card-head">
          <span className="plugin-tile big allow" aria-hidden="true">{letterOf(plugin.title)}</span>
          <div className="plugin-names">
            <h2 className="plugin-card-title">{w("plugins.cardTitle", { name: plugin.title })}</h2>
            <div className="plugin-meta">{plugin.version}{plugin.installedFrom ? ` · ${plugin.installedFrom}` : ""}</div>
          </div>
        </div>
        {!done && plugin.asks && (
          <>
            <div className="plugin-card-box">
              <div className="plugin-card-box-title">{w("plugins.cardCan")}</div>
              {can.length > 0 && <ul className="plugin-card-can">{can.map((line) => <li key={line}>{line}</li>)}</ul>}
              <div className="plugin-meta plugin-asks">{asksLine(plugin.asks)}</div>
            </div>
            <div className="plugin-meta plugin-card-note">{w("plugins.cardNote")}</div>
          </>
        )}
        {done && <div className="plugin-card-done" role="status">{w("plugins.cardDone")}</div>}
        {problem && <div className="plugins-problem" role="alert">{problem}</div>}
        <div className="plugin-card-buttons">
          {done
            ? <button type="button" className="plugin-card-primary" onClick={onClose}>{w("plugins.close")}</button>
            : <>
              <button type="button" className="plugin-card-cancel" onClick={onClose}>{w("plugins.cancel")}</button>
              <button type="button" className="plugin-grant-allow plugin-card-primary" disabled={sending} onClick={install}>{w("plugins.allowInstall")}</button>
            </>}
        </div>
      </div>
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="plugin-section">
    <h3>{title}</h3>
    {children}
  </section>
);

/** The chosen plugin: what to do first (Allow, Update), what it is, what it may do, its settings, commands and panels. */
function PluginDetail({ plugin, lang, catalog, updating, updated, busy, onAllow, onUpdate, onRemove, onEnable, onSetting, onSecret, onCommand, onPanel }: {
  plugin: PluginView;
  lang: Lang | null;
  /** The same plugin in the public catalog, if it is there. */
  catalog: PluginStoreEntryView | null;
  updating: boolean;
  updated: boolean;
  busy: boolean;
  onAllow: () => void;
  onUpdate: () => void;
  onRemove: () => void;
  onEnable: (enabled: boolean) => void;
  onSetting: (key: string, value: boolean | number | string | null) => void;
  onSecret: (key: string, value: string | null) => void;
  onCommand: (id: string, title: string) => void;
  onPanel: (id: string, title: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const w = (key: Parameters<typeof say>[1], values?: Record<string, string | number>) => say(lang, key, values);
  const needsAllow = canInstall(plugin);
  const update = catalog?.state === "update" && catalog.installedVersion === plugin.version;
  const access = permissionWords(lang, plugin.permissions);
  const settings = plugin.settings.filter((setting) => !setting.hidden);
  return (
    <div className="plugin-detail" data-detail={plugin.name} data-enabled={plugin.enabled ? "1" : "0"}>
      <div className="plugin-detail-head">
        <span className={`plugin-tile big${plugin.builtIn ? " built-in" : ""}${needsAllow ? " allow" : ""}`} aria-hidden="true">{letterOf(plugin.title)}</span>
        <div className="plugin-names">
          <h2 className="plugin-detail-title">{plugin.title}</h2>
          <div className="plugin-detail-sub">
            <span className="plugin-version">{plugin.version}</span>
            <span className="plugin-kind">{plugin.builtIn ? w("plugins.kindBuiltIn") : w("plugins.kindInstalled")}</span>
          </div>
        </div>
        <label className="plugin-toggle">
          <span>{plugin.enabled ? w("plugins.on") : w("plugins.off")}</span>
          <input type="checkbox" role="switch" className="plugin-switch" checked={plugin.enabled} onChange={(event) => onEnable(event.target.checked)} />
        </label>
      </div>
      {/* First, before anything else: the plugin waits for the user. */}
      {needsAllow && (
        <div className="plugin-allow-box" role="group" aria-label={w("plugins.needsAllowTitle")}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4.5" /><path d="M12 17.5v.01" /></svg>
          <div className="plugin-allow-text">
            <div className="plugin-allow-title">{w("plugins.needsAllowTitle")}</div>
            <div>{w("plugins.needsAllowBody")}</div>
          </div>
          <button type="button" className="plugin-allow-open big" onClick={onAllow}>{w("plugins.allow")}</button>
        </div>
      )}
      {update && !updating && !updated && (
        <div className="plugin-update-box">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11" /><path d="M7 10l5 5 5-5" /><path d="M5 20h14" /></svg>
          <div className="plugin-update-text"><div className="plugin-update-title">{w("plugins.updateBox", { version: catalog.version })}</div><div>{w("plugins.updateBody")}</div></div>
          <button type="button" className="plugin-update" disabled={busy} onClick={onUpdate}>{w("plugins.update", { version: catalog.version })}</button>
        </div>
      )}
      {updating && (
        <div className="plugin-update-box" role="status">
          <span className="plugin-spinner" aria-hidden="true" />
          <div className="plugin-update-text">{catalog?.status?.kind === "checking" || update ? w("plugins.updatingBody", { version: catalog?.version ?? "" }) : w("plugins.checking")}</div>
        </div>
      )}
      {updated && !updating && <div className="plugin-done-box" role="status">{w("plugins.updated")}</div>}
      {plugin.failure && <div className="plugins-problem">Turned off: {plugin.failure}</div>}
      {plugin.skipped?.length ? <div className="plugins-problem plugins-skipped">Skipped (this Botling does not know or cannot read these; the rest loads): {plugin.skipped.join("; ")}</div> : null}
      {!plugin.enabled && !plugin.failure && <div className="plugin-off-note">{w("plugins.offNote")}</div>}
      {(plugin.description || plugin.builtIn || plugin.grant !== undefined || plugin.installedFrom || plugin.ignoredLibraryVersion !== undefined || plugin.replacesBuiltIn !== undefined || catalog?.state === "devCopy") && (
        <Section title={w("plugins.section.about")}>
          {plugin.description && <div className="plugin-description">{plugin.description}</div>}
          {plugin.builtIn && <div className="plugin-meta">Built into Botling{plugin.ignoredLibraryVersion !== undefined ? " (in use)" : ""}</div>}
          {plugin.grant !== undefined && !plugin.builtIn && (
            <div className="plugin-meta">{plugin.grant === "none" ? "Not installed on this machine" : "Installed on this machine: allowed, and so are its new versions"}</div>
          )}
          {/* Which copy runs when the library has one too (core/plugins/versions.ts): the library's at the built-in's version or newer. */}
          {plugin.ignoredLibraryVersion !== undefined && <div className="plugin-meta plugin-copy-ignored">Your plugin library's copy ({plugin.ignoredLibraryVersion}) is older and is ignored</div>}
          {plugin.replacesBuiltIn !== undefined && <div className="plugin-meta plugin-copy-library">Your plugin library's copy (in use) replaces the built-in {plugin.replacesBuiltIn}</div>}
          {plugin.installedFrom && <div className="plugin-meta">from {plugin.installedFrom}</div>}
          {catalog?.state === "devCopy" && <div className="plugin-meta plugin-dev-copy">{say(lang, "plugins.devCopy", { version: catalog.version })}</div>}
        </Section>
      )}
      {access.length > 0 && (
        <Section title={w("plugins.section.access")}>
          <div className="plugin-chips">{access.map((line) => <span key={line} className="plugin-chip">{line}</span>)}</div>
        </Section>
      )}
      {settings.length > 0 && (
        <Section title={w("plugins.section.settings")}>
          {/* A built-in plugin's settings set on the Settings page (`hidden`) are not repeated here. */}
          <div className="plugin-settings-card">
            {settings.map((setting) => (
              <div key={setting.key} className="plugin-setting" data-setting={setting.key}>
                <span className="plugin-setting-title">{setting.title}</span>
                {setting.secret ? <SecretField setting={setting} onSecret={(value) => onSecret(setting.key, value)} />
                  : setting.type === "boolean" ? <input type="checkbox" role="switch" className="plugin-switch" checked={setting.value === true} onChange={(event) => onSetting(setting.key, event.target.checked)} aria-label={setting.title} />
                  : setting.type === "enum" ? (
                    <select value={String(setting.value ?? "")} onChange={(event) => onSetting(setting.key, event.target.value)} aria-label={setting.title}>
                      {setting.options.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  ) : <TextField setting={setting} onSave={(value) => onSetting(setting.key, setting.type === "number" ? (value.trim() === "" ? null : Number(value)) : value)} />}
              </div>
            ))}
          </div>
        </Section>
      )}
      {(plugin.commands.length > 0 || plugin.panels.length > 0) && (
        <Section title={w("plugins.section.use")}>
          <div className="plugin-buttons">
            {plugin.commands.map((command) => (
              <button key={command.id} type="button" disabled={!plugin.enabled || !command.registered} title={command.registered ? command.id : "Its program part has not registered it"} onClick={() => onCommand(command.id, command.title)}>{command.title}</button>
            ))}
            {plugin.panels.map((panel) => <button key={panel.id} type="button" className="plugin-panel-button" onClick={() => onPanel(panel.id, panel.title)}>Open {panel.title}</button>)}
          </div>
        </Section>
      )}
      {plugin.removable && (
        <div className="plugin-foot">
          {!asking && <button type="button" className="plugin-remove" disabled={busy} onClick={() => setAsking(true)}>{w("plugins.remove")}</button>}
          {asking && (
            <div className="plugin-row plugin-remove-ask" role="alertdialog" aria-label={w("plugins.removeAsk", { name: plugin.title })}>
              <span className="plugins-problem">{w("plugins.removeAsk", { name: plugin.title })}</span>
              <span className="plugin-buttons">
                <button type="button" className="plugin-remove-yes" onClick={() => { setAsking(false); onRemove(); }}>{w("plugins.removeYes")}</button>
                <button type="button" onClick={() => setAsking(false)}>{w("plugins.cancel")}</button>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The dependency board (botling.deps) inside the Plugins page: its frame, which also reads every few seconds. */
function DepsTab({ client, plugins, lang }: { client: Client; plugins: PluginsView | null; lang: Lang | null }) {
  const deps = plugins?.plugins.find((plugin) => plugin.name === DEPS_PLUGIN);
  if (!deps || !deps.enabled || deps.failure) return <div className="plugins-deps"><p className="plugins-empty">{say(lang, "plugins.depsOff")}</p></div>;
  return <div className="plugins-deps"><SlotFrame client={client} plugin={DEPS_PLUGIN} view={DEPS_VIEW} title="Plugin dependencies" fontSize={15} /></div>;
}
/** The plugin that draws the board, and its view (its `settings.section` page, which Settings no longer lists on its own). */
export const DEPS_PLUGIN = "botling.deps";
export const DEPS_VIEW = "botling.deps.board";

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
    // The state of its program part (`ccb.host.onStatus`): told when the plugin list changes it (the first list is told too).
    let lastHost: string | undefined;
    return client.onEvent(({ event }) => {
      if (event.type === "plugins.updated") {
        const state = event.plugins.plugins.find((each) => each.name === plugin)?.hostState ?? "none";
        if (state !== lastHost) { lastHost = state; frame.current?.contentWindow?.postMessage(frameEvent("hostStatus", state), "*"); }
        return;
      }
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
