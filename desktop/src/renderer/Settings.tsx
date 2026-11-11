import { DoctorSection } from "./Doctor";
import { ShellOverlay } from "./ShellOverlay";
import { PhoneSettings } from "./PhoneSettings";
import { MachinesSettings } from "./MachinesSettings";
import { UpdateActions } from "./Updates";
// The Settings window as a sheet over the app, in four groups (settings-pages.ts): App (General, Appearance,
// Shortcuts), Bots (Models & workers, Permissions, Chat & reports), Connect (Engine setup, Plugins and their pages,
// Phone, Machines) and Advanced (Updates, Developer). Everything here is global (settings.json); the shown bot's own choices (its
// bot.json) are `BotSettings`, in the right panel one level in. Each control shows what the core saved: a change goes
// out, the answer (or `settings.updated`) comes back.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BotView, PluginsView, SettingsChange, SettingsView, UpdateView } from "../contract";
import { Client } from "./client";
import { PanelFrame, PluginsPanel, SlotFrame } from "./Plugins";
import { faceURL } from "./avatars";
import { FIXED_SHORTCUTS, SHORTCUTS, bindingsFor, comboFromEvent, findConflict, formatCombo, normalizeOverrides, pluginBindings, resetBinding, setBinding, type Conflict } from "../contract/shortcuts";
import { keybindingsOf } from "./plugin-commands";
import { say, shellPlatform } from "./shortcut-labels";
import type { Key } from "../../../Web/src/locales/en";
import { Group, Row, Segmented, Toggle, why } from "./settings-controls";
import { resolveSection, settingsNav, type SettingsSection } from "./settings-pages";
import { ModelsWorkers } from "./ModelsWorkers";
import { ChatSummaries, type CodexModelOption } from "./chat-summaries";
export { BotSettings } from "./BotPanelSettings";
export type { SettingsSection } from "./settings-pages";

const LANGUAGES: { id: SettingsView["language"]; label: string }[] = [
  { id: null, label: "System default" }, { id: "en", label: "English" }, { id: "zh-Hant", label: "繁體中文" },
];
const STALL = [5, 10, 15, 30, 60, 0];

/** The models the local Codex lists (`codex.models`, asked of `codex app-server` once per run); empty until it answers. */
function useCodexModels(client: Client, wanted = true) {
  const [models, setModels] = useState<CodexModelOption[]>([]);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void client.request({ type: "codex.models" }).then((result) => { if (live) setModels(Array.isArray(result?.models) ? result.models : []); }, () => { if (live) setModels([]); });
    return () => { live = false; };
  }, [client, wanted]);
  return models;
}

export function SettingsSheet({ client, settings, bot, bots = [], plugins, initialSection = "general", onClose, onOpenBot }: { client: Client; settings: SettingsView | null; bot: BotView | null; bots?: BotView[]; plugins: PluginsView | null; initialSection?: SettingsSection; onClose: () => void; onOpenBot?: (botId: string) => void }) {
  const [section, setSection] = useState<SettingsSection>(resolveSection(initialSection));
  const [search, setSearch] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<SettingsView | null>(settings);
  const codexModels = useCodexModels(client);
  useEffect(() => { if (settings) setShown(settings); }, [settings]);
  useEffect(() => { if (!settings) void client.request({ type: "settings.get" }).then(setShown, (failure) => setProblem(why(failure))); }, [client, settings]);
  const change = useCallback((next: SettingsChange) => {
    setProblem(null);
    return client.request({ type: "settings.set", change: next }).then(value => { setShown(value); return true; }, failure => { setProblem(why(failure)); return false; });
  }, [client]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const groups = useMemo(() => settingsNav(plugins, search), [search, plugins]);
  const pages = groups.flatMap((group) => group.pages);
  const wanted = resolveSection(section);
  const current = pages.find((entry) => entry.id === wanted) ?? pages[0];
  const go = useCallback((next: SettingsSection) => { setSearch(""); setSection(resolveSection(next)); }, []);
  const modelBotId = bot?.id ?? bots[0]?.id ?? null;
  return (
    <ShellOverlay><div className="settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="settings" role="dialog" aria-label="Settings" aria-modal="true">
        <nav className="settings-side" aria-label="Settings sections">
          <input className="settings-search" type="search" placeholder="Search settings" aria-label="Search settings" value={search} onChange={(event) => setSearch(event.target.value)} />
          {groups.map((group) => (
            <div key={group.title} className="settings-nav-group" role="group" aria-label={group.title}>
              <div className="settings-nav-title">{group.title}</div>
              {group.pages.map((entry) => (
                <button key={entry.id} type="button" className={`settings-tab${entry.indent ? " indent" : ""}${current?.id === entry.id ? " on" : ""}`} aria-current={current?.id === entry.id ? "page" : undefined} onClick={() => setSection(entry.id)}>
                  {entry.title}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <section className="settings-main">
          <header className="settings-header">
            <h2>{current?.title ?? "No match"}</h2>
            <button type="button" className="settings-done" onClick={onClose}>Done</button>
          </header>
          {problem && <p className="settings-problem" role="alert">{problem}</p>}
          <div className="settings-body">
            {shown && current?.id === "general" && <General settings={shown} change={change} onNavigate={go} />}
            {shown && current?.id === "appearance" && <Appearance settings={shown} change={change} bot={bot} />}
            {shown && current?.id === "shortcuts" && <Shortcuts settings={shown} change={change} plugins={plugins} />}
            {shown && current?.id === "models" && <ModelsWorkers client={client} settings={shown} change={change} bots={bots} modelBotId={modelBotId} codexModels={codexModels} plugins={plugins} onProblem={setProblem} onNavigate={go}
              onOpenBot={onOpenBot ? (botId) => { onOpenBot(botId); onClose(); } : undefined} />}
            {shown && current?.id === "permissions" && <Permissions client={client} settings={shown} change={change} />}
            {shown && current?.id === "chat" && <ChatAndReports client={client} settings={shown} change={change} plugins={plugins} onProblem={setProblem} onNavigate={go} />}
            {current?.id === "setup" && <EngineSetup client={client} settings={shown} change={change} />}
            {current?.id === "plugins" && <PluginsSection client={client} plugins={plugins} />}
            {current?.plugin && <SlotFrame key={current.id} client={client} plugin={current.plugin} view={current.view ?? current.id} title={current.title} fontSize={15} />}
            {shown && current?.id === "phone" && <PhoneSettings client={client} bots={bots} lang={shown.effectiveLanguage} />}
            {shown && current?.id === "machines" && <MachinesSettings client={client} lang={shown.effectiveLanguage} />}
            {shown && current?.id === "updates" && <Updates client={client} settings={shown} change={change} />}
            {shown && current?.id === "developer" && <Developer settings={shown} change={change} bots={bots} />}
          </div>
        </section>
      </div>
    </div></ShellOverlay>
  );
}

/** Settings → General: language, the bots' look, and when a stuck bot reminds you; where the settings that left it went. */
function General({ settings, change, onNavigate }: { settings: SettingsView; change: (next: SettingsChange) => void; onNavigate: (section: SettingsSection) => void }) {
  return (
    <>
      <Group title="Language">
        <Row label="App language" hint="The app’s words and what bots reply in.">
          <select aria-label="App language" value={settings.language ?? ""} onChange={(event) => change({ key: "language", value: (event.target.value || null) as SettingsView["language"] })}>
            {LANGUAGES.map((language) => <option key={language.id ?? ""} value={language.id ?? ""}>{language.id === null ? `System default (${LANGUAGES.find((entry) => entry.id === settings.effectiveLanguage)?.label ?? "English"})` : language.label}</option>)}
          </select>
        </Row>
      </Group>
      <Group title="Bots">
        <Row label="Bot look">
          <Segmented label="Bot look" options={[{ id: "original", label: "Original" }, { id: "cute", label: "Cute" }] as const} value={settings.botLook} onChange={(value) => change({ key: "botLook", value })} />
        </Row>
        <Row label="Remind me when a bot is stuck" hint="After no new step from a bot or worker for this long, you get a reminder in its chat.">
          <select aria-label="Remind after no new step for" value={settings.stallReminderMinutes} onChange={(event) => change({ key: "stallReminderMinutes", value: Number(event.target.value) })}>
            {[...new Set([...STALL, settings.stallReminderMinutes])].map((minutes) => <option key={minutes} value={minutes}>{minutes === 0 ? "Never" : `${minutes} min`}</option>)}
          </select>
        </Row>
      </Group>
      <Group title="Moved from here">
        <Row label="Chat avatar size"><button type="button" className="settings-link" onClick={() => onNavigate("appearance")}>Appearance</button></Row>
        <Row label="Chat summaries"><button type="button" className="settings-link" onClick={() => onNavigate("chat")}>Chat &amp; reports</button></Row>
        <Row label="Summary model"><button type="button" className="settings-link" onClick={() => onNavigate("models")}>Models &amp; workers</button></Row>
      </Group>
    </>
  );
}

/** The theme cards: a small picture of the app in each look, drawn with the app's own ground and side colours. */
const THEMES = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "Match system" },
] as const;

/** Settings → Appearance: the app's theme, report pages, and the chat's avatar size. */
function Appearance({ settings, change, bot }: { settings: SettingsView; change: (next: SettingsChange) => Promise<boolean>; bot: BotView | null }) {
  const size = settings.chatAvatarSize ?? 48;
  const preview = { avatar: bot?.avatar ?? "circle", heads: bot?.heads ?? ["claude"] };
  const theme = settings.appTheme ?? "dark";
  return <>
  <section className="settings-group" aria-label="Theme">
    <div className="settings-group-head"><h3>Theme</h3></div>
    <div className="theme-cards" role="radiogroup" aria-label="App appearance">
      {THEMES.map((option) => (
        <button key={option.id} type="button" role="radio" aria-checked={theme === option.id} className={`theme-card${theme === option.id ? " on" : ""}`} onClick={() => void change({ key: "appTheme", value: option.id })}>
          <span className={`theme-thumb theme-thumb-${option.id}`} aria-hidden="true"><span className="theme-thumb-side" /><span className="theme-thumb-main"><span /><span /></span></span>
          {option.label}
        </button>
      ))}
    </div>
    <div className="settings-card">
      <Row label="Report pages" hint="Result pages and their charts. Pages already open change when they are opened again.">
        <Segmented label="Report pages" options={[{ id: "system", label: "Match app" }, { id: "light", label: "Light" }, { id: "dark", label: "Dark" }] as const} value={settings.reportTheme ?? "system"} onChange={(value) => void change({ key: "reportTheme", value })} />
      </Row>
    </div>
    <p className="settings-note">The look of the whole app: chat, sidebar, Settings, Board and panels. It changes right away.</p>
  </section>
  <Group title="Chat">
    <Row label="Avatar size" hint={`${size} px${settings.chatAvatarSize === null ? " (default)" : ""}`}>
      <img className="settings-avatar-preview" src={faceURL(preview, settings.botLook)} alt="Preview" width={28} height={28} />
      <input type="range" aria-label="Chat avatar size" min={32} max={96} value={size} onChange={(event) => void change({ key: "chatAvatarSize", value: Number(event.target.value) })} />
    </Row>
  </Group>
  <div className="settings-actions settings-actions-end">
    <button type="button" disabled={settings.chatAvatarSize === null}
      onClick={() => void change({ key: "chatAvatarSize", value: null })}>Reset avatar size</button>
  </div>
  </>;
}

/** The engines' permission choice: the same two-step control for each, with what each step means for that engine. */
const PERMISSION_ENGINES = [
  { engine: "claude", name: "Claude", key: "claudeBypassPermissions", safe: "Auto",
    safeText: "Claude checks each tool use; risky ones come to you as an approval card.",
    fullText: "Skips Claude’s permission checks for bots and Claude workers. Protected paths, explicit tool limits, managed policy and OS protections still apply." },
  { engine: "codex", name: "Codex", key: "codexBypassPermissions", safe: "Auto",
    safeText: "Codex runs in its sandbox and asks before risky commands.",
    fullText: "No approval prompts, no auto review, no file or network sandbox for bots and Codex workers. Commands run with your Mac user’s access." },
  { engine: "agy", name: "Antigravity", key: "agyBypassPermissions", safe: "Ask",
    safeText: "Every action comes to you as a single approval card.",
    fullText: "Reads, writes and shell commands are allowed, also outside the project, with your Mac user’s access; removes Botling’s command sandbox. Stops running Antigravity sessions to apply." },
] as const;

/** Settings → Permissions: how much bots and their workers may do without asking, per engine; and where results go. */
function Permissions({ client, settings, change }: { client: Client; settings: SettingsView; change: (next: SettingsChange) => Promise<boolean> }) {
  return <>
    <p className="settings-lead">How much a bot and its workers may do without asking you. Applies to every bot, when an engine process next starts.</p>
    {PERMISSION_ENGINES.map((entry) => {
      const full = settings[entry.key];
      return (
        <section key={entry.engine} className="permission-card" aria-label={`${entry.name} permissions`}>
          <div className="permission-head">
            <h3>{entry.name}</h3>
            <Segmented label={`${entry.name} permission`} options={[{ id: "safe", label: entry.safe }, { id: "full", label: "Full access" }] as const} value={full ? "full" : "safe"}
              onChange={(value) => void change({ key: entry.key, value: value === "full" })} />
          </div>
          <div className="permission-choices">
            <div className="permission-choice"><strong>{entry.safe}</strong> · {entry.safeText}</div>
            <div className="permission-choice full"><strong>Full access</strong> · {entry.fullText}</div>
          </div>
          {entry.engine === "agy"
            ? <AntigravitySessions client={client} settings={settings} />
            : <p className="settings-hint">In effect: {full ? "Full access" : entry.safe} · for bots and {entry.name} workers, from the next engine start</p>}
        </section>
      );
    })}
    <p className="settings-note">Auto lets the engine allow low- and medium-risk actions and ask you for high-risk ones; its judgment is not guaranteed. Unknown risk, review failures and OS or sandbox blocks are not auto-approved. Protected paths, managed policies and OS protections always apply. Running sessions keep their mode until they restart: let work finish, then restart the app. No new conversation is needed.</p>
    <Group title="Where results go">
      <Row label="Reports and pages" hint="An Artifact is a private claude.ai page; a local page stays on this Mac.">
        <PublishAs settings={settings} change={change} />
      </Row>
    </Group>
  </>;
}

function PublishAs({ settings, change }: { settings: SettingsView; change: (next: SettingsChange) => void }) {
  return (
    <select aria-label="Publish as" value={settings.resultPublishing} onChange={(event) => change({ key: "resultPublishing", value: event.target.value as SettingsView["resultPublishing"] })}>
      <option value="artifactUnlessSensitive">Artifact, sensitive ones local</option>
      <option value="localOnly">Always a local HTML page</option>
      <option value="artifactAlways">Always an Artifact</option>
    </select>
  );
}

/** Antigravity's live permission state: what its running sessions confirmed (selection and effect are kept apart). */
function AntigravitySessions({ client, settings }: { client: Client; settings: SettingsView }) {
  const [sessions,setSessions]=useState(settings.agyPermissionSessions);
  const [error,setError]=useState("");
  useEffect(()=>{
    let live=true;
    const refresh=async()=>{try{const view=await client.request({type:"settings.get"});if(live){setSessions(view.agyPermissionSessions ?? []);setError("");}}catch{if(live){setSessions([]);setError("Cannot read effective Antigravity permission status.");}}};
    void refresh();const timer=setInterval(()=>void refresh(),2000);
    return ()=>{live=false;clearInterval(timer);};
  },[client,settings.agyBypassPermissions]);
  return <>
    <p className="settings-hint">Selected: {settings.agyBypassPermissions ? "Full access (yolo)" : "Ask for approval (default)"}. It is in effect once the runtime confirms it; continue the conversation to apply, no app restart needed.</p>
    {error ? <p className="settings-problem" role="alert">{error}</p> : sessions.length ? sessions.map((s,i)=><p key={s.sessionId+":"+i} className={s.state==="error"?"settings-problem":"settings-hint"} role={s.state==="error"?"alert":"status"}>Session {s.sessionId.slice(0,8)} — {s.state}: {s.message}</p>) : <p className="settings-hint" role="status">No Antigravity session running · nothing to apply</p>}
  </>;
}

/** Antigravity's full-permission switch on its own (kept for places that show only it). */
export function AntigravityPermissions({client,settings,change}: {client:Client;settings:SettingsView;change:(next:SettingsChange)=>Promise<boolean>}) {
  return <Group title="Antigravity permissions" note="Changing this setting stops Antigravity session processes and their active tools. Continue the conversation to apply the new mode; no app restart is required.">
    <Toggle label="Antigravity: Full permission" hint="Automatically allows file reads, writes and shell commands, including outside the project, with the app user's OS access. Removes Botling's command sandbox. This does not authorize work outside your task. App install/update confirmations and runtime administrator restrictions remain." checked={settings.agyBypassPermissions} onChange={value=>change({key:"agyBypassPermissions",value})}/>
    <AntigravitySessions client={client} settings={settings} />
  </Group>;
}

/** Settings → Chat & reports: chat summaries (botling.catchup) and how reports are published. */
function ChatAndReports({ client, settings, change, plugins, onProblem, onNavigate }: { client: Client; settings: SettingsView; change: (next: SettingsChange) => void; plugins: PluginsView | null; onProblem: (problem: string | null) => void; onNavigate: (section: SettingsSection) => void }) {
  return <>
    <ChatSummaries client={client} plugins={plugins} onProblem={onProblem} onModel={() => onNavigate("models")} />
    <Group title="Reports and results" note="What a bot does with a report or a page it made.">
      <Row label="Publish as"><PublishAs settings={settings} change={change} /></Row>
    </Group>
  </>;
}

/** Settings → Engine setup: each engine's command-line tool (installed, version, signed in) and Antigravity's runtime path. */
function EngineSetup({ client, settings, change }: { client: Client; settings: SettingsView | null; change: (next: SettingsChange) => Promise<boolean> }) {
  return <>
    <DoctorSection client={client} />
    {settings && <AntigravityRuntime client={client} settings={settings} change={change} />}
  </>;
}

function AntigravityRuntime({ client, settings, change }: { client: Client; settings: SettingsView; change: (next: SettingsChange) => Promise<boolean> }) {
  const [path, setPath] = useState(settings.agyAcpPath ?? "");
  const [status, setStatus] = useState<import("../contract").ResultOf<"agy.runtime.check"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setPath(settings.agyAcpPath ?? ""); }, [settings.agyAcpPath]);
  useEffect(() => {
    let live = true;
    void client.request({ type: "agy.runtime.check" }).then(value => { if (live) setStatus(value); }, failure => { if (live) setError(why(failure)); });
    return () => { live = false; };
  }, [client, settings.agyAcpPath]);
  const run = async (save: boolean) => {
    setBusy(true); setError(null); setStatus(null);
    try {
      if (save && !await change({ key: "agyAcpPath", value: path.trim() || null })) return;
      setStatus(await client.request({ type: "agy.runtime.check" }));
    } catch (failure) { setError(why(failure)); }
    finally { setBusy(false); }
  };
  return <Group title="Antigravity runtime" note="Official ACP 1.4.3 for macOS arm64. Requires agy_acp_server.par, localharness_external and the verified Botling file helper in the same folder, outside your projects. Antigravity above can install it locally and set this path for you. This path editor does not download or launch files.">
    <Row label="Official ACP runtime path">
      <input aria-label="Official ACP runtime path" type="text" value={path} disabled={busy} placeholder="/absolute/path/agy_acp_server.par" onChange={event => { setPath(event.target.value); setStatus(null); }} />
    </Row>
    <p className="settings-hint">Takes effect on the next Antigravity launch. BOTLING_AGY_ACP_PATH takes priority over this saved path. Clear the field and save to remove the saved choice.</p>
    <div className="settings-actions agy-runtime-actions">
      <button type="button" className="settings-done" disabled={busy} onClick={() => void run(true)}>{busy ? "Verifying…" : "Save and verify"}</button>
      <button type="button" disabled={busy} onClick={() => void run(false)}>Check active runtime</button>
    </div>
    {status?.override && <p className="settings-hint">Environment override active: {status.override}. To use the saved path, remove BOTLING_AGY_ACP_PATH and restart the app.</p>}
    {status?.effective && <p className="settings-hint">Active path: {status.effective}</p>}
    {status?.message && <p className={status.valid ? "settings-hint" : "settings-problem"} role={status.valid ? "status" : "alert"}>{status.message}</p>}
    {error && <p className="settings-problem" role="alert">{error}</p>}
  </Group>;
}

/** Settings → Updates: discovery (electron-updater), explicit download and restart. */
function Updates({ client, settings, change }: { client: Client; settings: SettingsView; change: (next: SettingsChange) => void }) {
  const [state, setState] = useState<UpdateView | null>(null);
  const [checking, setChecking] = useState(false);
  const check = useCallback((manual: boolean) => {
    setChecking(manual);
    void client.request({ type: "updates.check", manual }).then(setState, () => {}).finally(() => setChecking(false));
  }, [client]);
  useEffect(() => { check(false); }, [check, settings.updateCheck]);
  const found = state?.newer;
  const line = checking ? "Looking…"
    : state?.error ? state.error
    : found ? `Botling ${found.version} is available${found.asset ? ` (${found.asset})` : ""}.`
    : state?.checkedAt ? `Botling ${state.current} is the newest (looked ${new Date(state.checkedAt).toLocaleString()}).`
    : `This is Botling ${state?.current ?? "2"}; not looked yet.`;
  return (
    <Group title="Updates">
      <Toggle label="Check for updates" checked={settings.updateCheck} onChange={(value) => change({ key: "updateCheck", value })} />
      <Row label="Status" hint={line}>
        <span className="settings-actions">
          <button type="button" disabled={checking} onClick={() => check(true)}>Check now</button>
          {state && <UpdateActions client={client} state={state} onChange={setState} />}
          {found && <button type="button" onClick={() => void client.request({ type: "updates.open" }).catch(() => {})}>Open release page</button>}
        </span>
      </Row>
    </Group>
  );
}

/**
 * Developer mode (1.x's Settings → Developer): one project is Botling's own source and gets what you flag as
 * "not right" in any chat, with the chat around it; its manager may install builds it made (you confirm on a card in
 * the main bot's chat) and see the app's window (botling.dev and core/self-update.ts).
 */
/**
 * Settings → Shortcuts: every key the app handles, grouped, with its action and current key, then the keys plugins
 * add (plugin-platform.md §3.3). Click a key and press the new combination (Esc cancels); a key another shortcut,
 * a plugin or the system already has is refused with its name. A plugin key taken by the app is shown as off.
 * Saved in settings.json and applied at once (the menu is rebuilt by main, the pages read the binding).
 */
function Shortcuts({ settings, change, plugins }: { settings: SettingsView; change: (next: SettingsChange) => Promise<boolean>; plugins: PluginsView | null }) {
  const lang = settings.effectiveLanguage;
  const platform = shellPlatform();
  const overrides = useMemo(() => normalizeOverrides(settings.shortcuts), [settings.shortcuts]);
  const bindings = bindingsFor(overrides);
  const keybindings = useMemo(() => keybindingsOf(plugins), [plugins]);
  const pluginKeys = pluginBindings(keybindings, overrides);
  const [recording, setRecording] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ id: string; text: string } | null>(null);
  const latest = useRef({ overrides, change, keybindings }); latest.current = { overrides, change, keybindings };
  const word = (key: string, values?: Record<string, string | number>) => say(lang, key as Key, values);
  /** What a conflict is called: the app shortcut's action, the plugin command's title or the system key's name. */
  const named = (conflict: Conflict) => conflict.kind === "shortcut" ? word(`shortcuts.action.${conflict.id}`)
    : conflict.kind === "command" ? latest.current.keybindings.find((binding) => binding.command === conflict.id)?.title ?? conflict.id : word(`shortcuts.fixed.${conflict.id}`);
  useEffect(() => {
    if (!recording) return;
    // The menu's accelerators step aside while a key is recorded, so Cmd+R and the like reach this page.
    (window as unknown as { botling?: { shortcuts?: { suspend(on: boolean): void } } }).botling?.shortcuts?.suspend(true);
    const onKey = (event: KeyboardEvent) => {
      if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      if (event.key === "Escape") { setRecording(null); setRefusal(null); return; }
      const combo = comboFromEvent(event, platform);
      if (!combo) { setRefusal({ id: recording, text: word("shortcuts.needModifier") }); return; }
      const conflict = findConflict(recording, combo, latest.current.overrides, latest.current.keybindings);
      if (conflict) {
        setRefusal({ id: recording, text: word(conflict.kind === "fixed" ? "shortcuts.reserved" : "shortcuts.conflict", { key: formatCombo(combo, platform), action: named(conflict) }) });
        return;
      }
      setRecording(null); setRefusal(null);
      const plugin = latest.current.keybindings.find((binding) => binding.command === recording);
      void latest.current.change({ key: "shortcuts", value: plugin ? setBinding(latest.current.overrides, recording, combo, plugin.key) : setBinding(latest.current.overrides, recording, combo) });
    };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); (window as unknown as { botling?: { shortcuts?: { suspend(on: boolean): void } } }).botling?.shortcuts?.suspend(false); };
  }, [recording, platform, lang]);
  const groups = (["navigation", "panels", "view"] as const).map((group) => ({ group, items: SHORTCUTS.filter((entry) => entry.group === group) }));
  return <>
    {groups.map(({ group, items }) => (
      <Group key={group} title={word(`shortcuts.group.${group}`)} note={group === "navigation" ? word("shortcuts.note") : undefined}>
        {items.map((entry) => {
          const isDefault = bindings[entry.id] === entry.default;
          const action = word(`shortcuts.action.${entry.id}`);
          return (
            <Row key={entry.id} label={action} hint={refusal?.id === entry.id ? refusal.text : isDefault ? undefined : word("shortcuts.defaultKey", { key: formatCombo(entry.default, platform) })}>
              <button type="button" aria-label={word("shortcuts.change", { action })} onClick={() => { setRefusal(null); setRecording(recording === entry.id ? null : entry.id); }}
                onBlur={() => { if (recording === entry.id) { setRecording(null); setRefusal(null); } }}>
                {recording === entry.id ? word("shortcuts.recording") : formatCombo(bindings[entry.id], platform)}
              </button>
              <button type="button" disabled={isDefault} onClick={() => { setRecording(null); setRefusal(null); void change({ key: "shortcuts", value: resetBinding(overrides, entry.id) }); }}>{word("shortcuts.reset")}</button>
            </Row>
          );
        })}
        {group === "view" && <div className="settings-actions"><button type="button" disabled={!Object.keys(overrides).length}
          onClick={() => { setRecording(null); setRefusal(null); void change({ key: "shortcuts", value: {} }); }}>{word("shortcuts.resetAll")}</button></div>}
      </Group>
    ))}
    {pluginKeys.length > 0 && <Group title={word("shortcuts.group.plugins")} note={word("shortcuts.pluginNote")}>
      {pluginKeys.map((entry) => {
        const isDefault = !overrides[entry.command];
        const hint = refusal?.id === entry.command ? refusal.text
          : entry.conflict && entry.combo === null ? word("shortcuts.pluginTaken", { key: formatCombo(overrides[entry.command] ?? entry.key, platform), action: named(entry.conflict) })
          : isDefault ? entry.plugin : `${entry.plugin} · ${word("shortcuts.defaultKey", { key: formatCombo(entry.key, platform) })}`;
        return (
          <Row key={entry.command} label={entry.title} hint={hint}>
            <button type="button" aria-label={word("shortcuts.change", { action: entry.title })} onClick={() => { setRefusal(null); setRecording(recording === entry.command ? null : entry.command); }}
              onBlur={() => { if (recording === entry.command) { setRecording(null); setRefusal(null); } }}>
              {recording === entry.command ? word("shortcuts.recording") : entry.combo ? formatCombo(entry.combo, platform) : word("shortcuts.pluginNoKey")}
            </button>
            <button type="button" disabled={isDefault} onClick={() => { setRecording(null); setRefusal(null); void change({ key: "shortcuts", value: resetBinding(overrides, entry.command) }); }}>{word("shortcuts.reset")}</button>
          </Row>
        );
      })}
    </Group>}
    {(["system", "chat"] as const).map((group) => (
      <Group key={group} title={word(`shortcuts.group.${group}`)} note={group === "chat" ? word("shortcuts.fixedNote") : undefined}>
        {FIXED_SHORTCUTS.filter((entry) => entry.group === group && (entry.platform === undefined || (entry.platform === "mac") === (platform === "darwin"))).map((entry) => (
          <Row key={entry.id} label={word(`shortcuts.fixed.${entry.id}`)}><span className="settings-hint">{formatCombo(entry.combo, platform)}</span></Row>
        ))}
      </Group>
    ))}
  </>;
}

function Developer({ settings, change, bots }: { settings: SettingsView; change: (next: SettingsChange) => void; bots: BotView[] }) {
  const projects = bots.filter((candidate) => candidate.role === "manager" && candidate.id !== "DEC0DE00-0000-4000-8000-00000000DEC0");
  return (
    <Group title="Developer mode" note={settings.developerMode
      ? `${projects.find((project) => project.id === settings.developerProject)?.name ?? "That project"}'s manager may install new builds (you confirm; one that does not start is rolled back), take screenshots of this window, and gets what you flag as “not right” in any chat. Every report is also kept in feedback.md.`
      : "Off for everyone who only uses Botling. Turn it on to let one project's manager work on the app itself."}>
      <Toggle label="Developer mode" checked={settings.developerMode} onChange={(value) => change({ key: "developerMode", value })} />
      <Row label="Botling's source" hint={projects.length ? undefined : "Add the project that holds Botling's source first."}>
        <select aria-label="Botling's source" value={settings.developerProject ?? ""} disabled={!settings.developerMode || !projects.length}
          onChange={(event) => change({ key: "developerProject", value: event.target.value || null })}>
          <option value="">Pick a project…</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </Row>
    </Group>
  );
}

function PluginsSection({ client, plugins }: { client: Client; plugins: PluginsView | null }) {
  const [panel, setPanel] = useState<{ plugin: string; id: string; title: string } | null>(null);
  return (
    <>
      <PluginsPanel client={client} plugins={plugins} embedded onPanel={setPanel} onClose={() => {}} />
      {panel && <PanelFrame client={client} plugin={panel.plugin} panel={panel.id} title={panel.title} onClose={() => setPanel(null)} />}
    </>
  );
}
