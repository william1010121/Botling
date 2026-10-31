import { useUsageRefresh } from "./QuickSettingsUsage";
import { AntigravityQuota } from "./AntigravityQuota";
import { ModelPicker, useModelDiscovery } from "./ModelPicker";
import { DoctorSection } from "./Doctor";
import { ShellOverlay } from "./ShellOverlay";
import { postToChat } from "./editor-surface";
import { UpdateActions } from "./Updates";
// The Settings window (1.x's SettingsWindow.swift) as a sheet over the app: its sections in 1.x's order
// and words, for what 2.0's core does. Everything here is global (settings.json); the shown bot's own
// choices (its bot.json) are `BotSettings`, in the right panel one level in, as in 1.x. Each
// control shows what the core saved: a change goes out, the answer (or `settings.updated`) comes back.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BotSettingsView, BotView, PluginsView, SettingsChange, SettingsView, UpdateView, UsageView } from "../contract";
import { asOf, countdown, dollars, isEmpty, percent, resetDay, staleSince, tokenCount, type Limits } from "./usage-text";
import { MESSAGE_WIDTH_DEFAULT, MESSAGE_WIDTH_MIN, MESSAGE_WIDTH_MAX } from "../contract/message-width";
import { Client, RequestFailed } from "./client";
import { PanelFrame, PluginsPanel } from "./Plugins";
import { faceURL } from "./avatars";
import { EFFORTS_BY_ENGINE } from "../contract/efforts";

const why = (failure: unknown) => (failure instanceof RequestFailed ? failure.error.message : String((failure as Error)?.message ?? failure));

export type SettingsSection = "general" | "appearance" | "engines" | "usage" | "permissions" | "plugins" | "doctor" | "updates" | "developer";
type Section = SettingsSection;
const SECTIONS: { id: Section; title: string; terms: string }[] = [
  { id: "general", title: "General", terms: "language bot look cute original chat avatars size summaries catch-up unread interval threshold prompt model reminders" },
  { id: "appearance", title: "Appearance", terms: "message column width chat composer size reset" },
  { id: "engines", title: "Engines and subagents", terms: "default engines models primary recipient apply all bots reasoning effort thinking antigravity full permission bypass agy acp runtime path claude subagents model prompt cache hour codex workers config effort fast completion verification component editor" },
  { id: "usage", title: "Usage", terms: "usage cost tokens spending today by bot earlier days subscription limits rate quota 5 hours week claude codex antigravity" },
  { id: "permissions", title: "Reports and results", terms: "publish artifact local html results reports" },
  { id: "plugins", title: "Plugins", terms: "plugins extensions settings secrets commands panels" },
  { id: "doctor", title: "Doctor", terms: "command-line tools claude codex antigravity install version login sign in check health" },
  { id: "updates", title: "Updates", terms: "updates version release github check new" },
  { id: "developer", title: "Developer", terms: "developer mode source project feedback not right" },
];

const LANGUAGES: { id: SettingsView["language"]; label: string }[] = [
  { id: null, label: "System default" }, { id: "en", label: "English" }, { id: "zh-Hant", label: "繁體中文" },
];
const MODELS = [{ id: "haiku", label: "Haiku" }, { id: "sonnet", label: "Sonnet" }, { id: "opus", label: "Opus" }] as const;
const EFFORTS = [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "xhigh", label: "Extra high" }, { id: "max", label: "Max" }] as const;
const STALL = [5, 10, 15, 30, 60, 0];
type CodexModelOption = { id: string; name: string; isDefault: boolean };

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
const codexOptions = (models: CodexModelOption[]) => models.map((model) => ({ id: model.id, label: `${model.name}${model.isDefault ? " (default)" : ""}` }));

export function SettingsSheet({ client, settings, bot, bots = [], plugins, initialSection = "general", onClose }: { client: Client; settings: SettingsView | null; bot: BotView | null; bots?: BotView[]; plugins: PluginsView | null; initialSection?: SettingsSection; onClose: () => void }) {
  const [section, setSection] = useState<Section>(initialSection);
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
  const sections = useMemo(() => {
    const words = search.trim().toLowerCase();
    return SECTIONS.filter((entry) => (!words || `${entry.title} ${entry.terms}`.toLowerCase().includes(words)));
  }, [search]);
  const current = sections.find((entry) => entry.id === section) ?? sections[0];
  return (
    <ShellOverlay><div className="settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="settings" role="dialog" aria-label="Settings" aria-modal="true">
        <nav className="settings-side">
          <input className="settings-search" type="search" placeholder="Search settings" aria-label="Search settings" value={search} onChange={(event) => setSearch(event.target.value)} />
          {sections.map((entry) => (
            <button key={entry.id} type="button" className={`settings-tab${current?.id === entry.id ? " on" : ""}`} aria-current={current?.id === entry.id ? "page" : undefined} onClick={() => setSection(entry.id)}>
              {entry.title}{entry.id === "engines" && <span className="settings-new">New</span>}
            </button>
          ))}
        </nav>
        <section className="settings-main">
          <header className="settings-header">
            <h2>{current?.title ?? "No match"}</h2>
            <button type="button" className="settings-done" onClick={onClose}>Done</button>
          </header>
          {problem && <p className="settings-problem" role="alert">{problem}</p>}
          <div className="settings-body">
            {shown && current?.id === "general" && <General settings={shown} change={change} bot={bot} codexModels={codexModels} />}
            {shown && current?.id === "appearance" && <Appearance settings={shown} change={change} />}
            {shown && current?.id === "engines" && <Engines client={client} settings={shown} change={change} codexModels={codexModels} modelBotId={bot?.id ?? bots[0]?.id ?? null} botCount={bots.length} />}
            {current?.id === "usage" && <Usage client={client} />}
            {shown && current?.id === "permissions" && <Results settings={shown} change={change} />}
            {current?.id === "plugins" && <PluginsSection client={client} plugins={plugins} />}
            {current?.id === "doctor" && <DoctorSection client={client} />}
            {shown && current?.id === "updates" && <Updates client={client} settings={shown} change={change} />}
            {shown && current?.id === "developer" && <Developer settings={shown} change={change} bots={bots} />}
          </div>
        </section>
      </div>
    </div></ShellOverlay>
  );
}

/**
 * Settings → Usage (1.x's usage page, Phase 5c): cost and tokens today, the subscriptions' limits as Claude and
 * Codex last reported them (they come with bots' turns only), by bot, and the days before. Read again each minute.
 */
function Usage({ client }: { client: Client }) {
  const {usage, now, loading, failed, retry} = useUsageRefresh(client);
  const tokens = usage?.tokens;
  const available = usage?.spendingStatus === "available";
  return (
    <>
      {loading && !usage && <p className="settings-note" role="status">Loading usage…</p>}
      {failed && <div className="settings-note" role="alert">
        Usage is unavailable.{" "}
        <button type="button" disabled={loading} onClick={retry}>Retry</button>
      </div>}
      {usage && <>
        <Group title="Usage today" note={available && tokens
          ? `${usage.day === localDay(now) ? "" : `${usage.day} · `}In ${tokenCount(tokens.input)} · out ${tokenCount(tokens.output)} · cache write ${tokenCount(tokens.cacheWrite)} · cache read ${tokenCount(tokens.cacheRead)}`
          : undefined}>
          {available && tokens ? <>
            <Row label="Cost"><span className="usage-number">{dollars(usage.spent)}</span></Row>
            <Row label="Tokens"><span className="usage-number">{tokenCount(tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead)}</span></Row>
          </> : <Row label="Recorded usage is unavailable." />}
        </Group>
        <Group title="Subscription limits">
          <LimitRow name="Claude" limits={usage.claude} now={now} />
          <LimitRow name="Codex" limits={usage.codex} now={now} />
          <Row label="Antigravity">
            <AntigravityQuota quota={usage.antigravity} failed={failed} loading={loading} onRetry={retry} />
          </Row>
        </Group>
        {available && <Group title="By bot">
          {!usage.byBot.length && <Row label="No bot has used anything today." />}
          {usage.byBot.map((bot) => <UsageRow key={bot.name} name={bot.name} spent={bot.spent} tokens={bot.tokens} />)}
        </Group>}
        {available && usage.history.length > 0 && <Group title="Earlier days">
          {[...usage.history].reverse().map((day) => <UsageRow key={day.day} name={day.day} spent={day.spent} tokens={day.tokens} />)}
        </Group>}
      </>}
    </>
  );
}

/** "2026-10-26": the local day, as the spending record names it. */
const localDay = (ms: number) => { const date = new Date(ms); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };

function UsageRow({ name, spent, tokens }: { name: string; spent: number; tokens: number }) {
  return (
    <Row label={name}>
      <span className="usage-line"><span className="usage-faint">{tokenCount(tokens)} tokens</span><span className="usage-number usage-cost">{dollars(spent)}</span></span>
    </Row>
  );
}

/** One subscription's 5-hour and weekly use, with when each starts over (1.x's LimitRow). */
function LimitRow({ name, limits, now }: { name: string; limits: Limits; now: number }) {
  const since = staleSince(limits, now);
  return (
    <Row label={name}>
      <span className="usage-limits" aria-label={`${name} limits`}>
        {isEmpty(limits) && <span className="usage-faint">no data</span>}
        {limits.fiveHour && <span>5 hours {percent(limits.fiveHour, now)} · {countdown(limits.fiveHour, now)}</span>}
        {limits.week && <span className="usage-faint">Week {percent(limits.week, now)} · {resetDay(limits.week, now)}</span>}
        {since !== null && <span className="usage-stale">{asOf(since, now)}</span>}
      </span>
    </Row>
  );
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
 * the main bot's chat) and see the app's window (core/app-swap.ts).
 */
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

function Group({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="settings-group" aria-label={title}>
      <h3>{title}</h3>
      <div className="settings-card">{children}</div>
      {note && <p className="settings-note">{note}</p>}
    </section>
  );
}

function Row({ label, children, hint }: { label: string; children?: React.ReactNode; hint?: string }) {
  return (
    <div className="settings-row">
      <div className="settings-label">{label}{hint && <div className="settings-hint">{hint}</div>}</div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

function Toggle({ label, checked, onChange, disabled, hint }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; hint?: string }) {
  return (
    <Row label={label} hint={hint}>
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    </Row>
  );
}

function Segmented<T extends string>({ label, options, value, onChange, disabled }: { label: string; options: readonly { id: T; label: string }[]; value: T | null; onChange: (value: T) => void; disabled?: boolean }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" role="radio" aria-checked={value === option.id} disabled={disabled} className={value === option.id ? "on" : ""} onClick={() => onChange(option.id)}>{option.label}</button>
      ))}
    </div>
  );
}

/**
 * A dropdown of choices; `blank` is the first option, for no choice (null). A saved value the list does not
 * have (an older setting, or a model the CLI no longer lists) stays as an extra option, so it is not lost.
 */
function SelectSetting({ label, options, value, onChange, blank, disabled }: { label: string; options: readonly { id: string; label: string }[]; value: string | null; onChange: (value: string | null) => void; blank?: string; disabled?: boolean }) {
  const extra = value !== null && value !== "" && !options.some((option) => option.id === value);
  return (
    <select aria-label={label} value={value ?? ""} disabled={disabled} onChange={(event) => onChange(event.target.value || null)}>
      {blank !== undefined && <option value="">{blank}</option>}
      {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      {extra && <option value={value}>{value}</option>}
    </select>
  );
}

function previewWidth(value: number | null | undefined) {
  postToChat({botling:"widthPreview",value});
}
function Appearance({ settings, change }: { settings: SettingsView; change: (next: SettingsChange) => Promise<boolean> }) {
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(settings.messageColumnWidth); latest.current = settings.messageColumnWidth;
  const editing = useRef<{before: number | null; value: number} | null>(null);
  const pending = useRef<number | undefined>(undefined);
  const [draft,setDraft] = useState<number | null>(null);
  const cancel = useCallback(() => { editing.current=null;pending.current=undefined;setDraft(null);previewWidth(undefined); },[]);
  // External updates win over an unfinished local drag, while unrelated settings pushes do not.
  const previous = useRef(settings.messageColumnWidth);
  useEffect(() => { if (previous.current !== settings.messageColumnWidth) { previous.current=settings.messageColumnWidth;cancel(); } },[settings.messageColumnWidth,cancel]);
  useEffect(() => () => previewWidth(undefined),[]);
  const commit = useCallback(() => {
    const edit=editing.current;if(!edit)return;editing.current=null;pending.current=edit.value;
    void change({key:"messageColumnWidth",value:edit.value}).then(ok=>{if(!ok)cancel();});
  },[change,cancel]);
  useEffect(() => { const el=input.current;el?.addEventListener("change",commit);return()=>el?.removeEventListener("change",commit); },[commit]);
  const width=draft ?? settings.messageColumnWidth ?? MESSAGE_WIDTH_DEFAULT;
  return <Group title="Message column" note="Drag either column edge to resize; double-click it to reset.">
    <Row label="Message column width" hint={`${width} px${settings.messageColumnWidth === null && draft===null ? " (default)" : ""}`}>
      <input ref={input} type="range" aria-label="Message column width" min={MESSAGE_WIDTH_MIN} max={MESSAGE_WIDTH_MAX} value={width}
        onInput={event=>{const value=Number(event.currentTarget.value);editing.current={before:editing.current?.before ?? latest.current,value};setDraft(value);previewWidth(value);}}
        onChange={()=>{}} onPointerUp={commit} onPointerCancel={cancel} onBlur={commit}
        onKeyUp={event=>{if(["ArrowLeft","ArrowRight","Home","End"].includes(event.key))commit();}}
        onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();cancel();}}} />
    </Row>
    <div className="settings-actions"><button type="button" disabled={settings.messageColumnWidth === null && draft===null}
      onClick={()=>{cancel();void change({key:"messageColumnWidth",value:null});}}>Use default width</button></div>
  </Group>;
}

function General({ settings, change, bot, codexModels }: { settings: SettingsView; change: (next: SettingsChange) => void; bot: BotView | null; codexModels: CodexModelOption[] }) {
  const [prompt, setPrompt] = useState(settings.summaryPrompt ?? settings.defaultSummaryPrompt);
  useEffect(() => setPrompt(settings.summaryPrompt ?? settings.defaultSummaryPrompt), [settings.summaryPrompt, settings.defaultSummaryPrompt]);
  const size = settings.chatAvatarSize ?? 48;
  const preview = { avatar: bot?.avatar ?? "circle", heads: bot?.heads ?? ["claude"] };
  return (
    <>
      <Group title="Language">
        <Row label="App language" hint="The chat page's words and what the bots reply in.">
          <select aria-label="App language" value={settings.language ?? ""} onChange={(event) => change({ key: "language", value: (event.target.value || null) as SettingsView["language"] })}>
            {LANGUAGES.map((language) => <option key={language.id ?? ""} value={language.id ?? ""}>{language.id === null ? `System default (${LANGUAGES.find((entry) => entry.id === settings.effectiveLanguage)?.label ?? "English"})` : language.label}</option>)}
          </select>
        </Row>
      </Group>
      <Group title="Bot look">
        <Row label="Bot look">
          <Segmented label="Bot look" options={[{ id: "original", label: "Original" }, { id: "cute", label: "Cute" }] as const} value={settings.botLook} onChange={(value) => change({ key: "botLook", value })} />
        </Row>
        <div className="settings-preview" aria-label="Preview">
          <img src={faceURL(preview, "original")} alt="Original" width={40} height={40} />
          <img src={faceURL(preview, "cute")} alt="Cute" width={40} height={40} />
        </div>
      </Group>
      <Group title="Chat avatars">
        <Row label="Chat avatar size" hint={`${size} px`}>
          <input type="range" aria-label="Chat avatar size" min={32} max={96} value={size} onChange={(event) => change({ key: "chatAvatarSize", value: Number(event.target.value) })} />
        </Row>
        <div className="settings-preview"><img src={faceURL(preview, settings.botLook)} alt="Preview" width={size} height={size} /></div>
        <div className="settings-actions"><button type="button" disabled={settings.chatAvatarSize === null} onClick={() => change({ key: "chatAvatarSize", value: null })}>Use default size</button></div>
      </Group>
      <Group title="Chat summaries">
        <Toggle label="Summarize unread messages" checked={settings.catchUpEnabled} onChange={(value) => change({ key: "catchUpEnabled", value })} />
        <Toggle label="Summarize between your messages" checked={settings.intervalSummaryEnabled} onChange={(value) => change({ key: "intervalSummaryEnabled", value })} />
        {settings.thresholdsCustomized ? (
          <>
            <Row label="Unread threshold"><input type="number" aria-label="Unread threshold" min={1} max={50} value={settings.catchUpThreshold} onChange={(event) => { const value = Number(event.target.value); if (value >= 1 && value <= 50) change({ key: "catchUpThreshold", value }); }} /></Row>
            <Row label="Interval threshold"><input type="number" aria-label="Interval threshold" min={1} max={50} value={settings.intervalSummaryThreshold} onChange={(event) => { const value = Number(event.target.value); if (value >= 1 && value <= 50) change({ key: "intervalSummaryThreshold", value }); }} /></Row>
            <div className="settings-actions"><button type="button" onClick={() => change({ key: "thresholdsCustomized", value: false })}>Use default thresholds</button></div>
          </>
        ) : (
          <Row label="Default thresholds: unread > 3, interval ≥ 3 bot replies">
            <button type="button" onClick={() => change({ key: "thresholdsCustomized", value: true })}>Adjust individually</button>
          </Row>
        )}
        <Row label="Summary model" hint={`Current summary model: ${settings.catchUpModel}`}>
          <SelectSetting label="Summary model" options={codexOptions(codexModels)} value={settings.catchUpModel} onChange={(value) => change({ key: "catchUpModel", value })} />
        </Row>
        <div className="settings-prompt">
          <div className="settings-label">Summary prompt <span className="settings-tag">{settings.summaryPrompt ? "Custom" : "Default"}</span></div>
          <textarea aria-label="Summary prompt" rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)}
            onBlur={() => { const next = prompt.trim() && prompt !== settings.defaultSummaryPrompt ? prompt : null; if (next !== settings.summaryPrompt) change({ key: "summaryPrompt", value: next }); }} />
          <div className="settings-actions"><button type="button" disabled={!settings.summaryPrompt} onClick={() => change({ key: "summaryPrompt", value: null })}>Restore default prompt</button></div>
        </div>
      </Group>
      <Group title="Reminders" note="When a running bot or subagent shows no new step for this long, you get a reminder in its chat. Never turns it off.">
        <Row label="Remind after no new step for">
          <select aria-label="Remind after no new step for" value={settings.stallReminderMinutes} onChange={(event) => change({ key: "stallReminderMinutes", value: Number(event.target.value) })}>
            {[...new Set([...STALL, settings.stallReminderMinutes])].map((minutes) => <option key={minutes} value={minutes}>{minutes === 0 ? "Never" : `${minutes} min`}</option>)}
          </select>
        </Row>
      </Group>
    </>
  );
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
  return <Group title="Antigravity" note="Official ACP 1.4.3 for macOS arm64. Requires agy_acp_server.par, localharness_external and the verified Botling file helper in the same folder, outside your projects. Use Settings → Doctor to install locally and configure automatically. This path editor does not download or launch files.">
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

/** Selection and effective runtime state are deliberately distinct. */
export function AntigravityPermissions({client,settings,change}: {client:Client;settings:SettingsView;change:(next:SettingsChange)=>Promise<boolean>}) {
  const [sessions,setSessions]=useState(settings.agyPermissionSessions);
  const [error,setError]=useState("");
  useEffect(()=>{
    let live=true;
    const refresh=async()=>{try{const view=await client.request({type:"settings.get"});if(live){setSessions(view.agyPermissionSessions ?? []);setError("");}}catch{if(live){setSessions([]);setError("Cannot read effective Antigravity permission status.");}}};
    void refresh();const timer=setInterval(()=>void refresh(),2000);
    return ()=>{live=false;clearInterval(timer);};
  },[client,settings.agyBypassPermissions]);
  return <Group title="Antigravity permissions" note="Changing this setting stops Antigravity session processes and their active tools. Continue the conversation to apply the new mode; no app restart is required.">
    <Toggle label="Antigravity: Full permission" hint="Automatically allows file reads, writes and shell commands, including outside the project, with the app user's OS access. Removes Botling's command sandbox. This does not authorize work outside your task. App install/update confirmations and runtime administrator restrictions remain." checked={settings.agyBypassPermissions} onChange={value=>change({key:"agyBypassPermissions",value})}/>
    <p className="settings-hint">Selected: {settings.agyBypassPermissions ? "Full permission (yolo)" : "Ask for approval (default)"}. Selection becomes effective only after the runtime confirms it.</p>
    {error ? <p className="settings-problem" role="alert">{error}</p> : sessions.length ? sessions.map((s,i)=><p key={s.sessionId+":"+i} className={s.state==="error"?"settings-problem":"settings-hint"} role={s.state==="error"?"alert":"status"}>Session {s.sessionId.slice(0,8)} — {s.state}: {s.message}</p>) : <p className="settings-hint" role="status">No Antigravity session process. No active tool permission.</p>}
  </Group>;
}

/** Only the levels the engine's own control takes (`EFFORTS_BY_ENGINE`). */
const effortOptions = (engine: "claude" | "codex" | "agy") => EFFORTS.filter((effort) => (EFFORTS_BY_ENGINE[engine] as readonly string[]).includes(effort.id));
const ENGINE_NAMES = { claude: "Claude", codex: "Codex", agy: "Antigravity" } as const;
type EngineId = keyof typeof ENGINE_NAMES;

/**
 * Settings → Engines and models: the engines a bot has, which one gets a message unless the bot says otherwise, each
 * engine's model and one reasoning effort. New bots start with these; "Apply to all bots" writes them into every
 * existing bot (after a confirmation, as it overwrites each bot's own choices).
 */
function EngineDefaults({ client, settings, change, botId, botCount }: { client: Client; settings: SettingsView; change: (next: SettingsChange) => Promise<boolean>; botId: string | null; botCount: number }) {
  const defaults = settings.engineDefaults;
  const [open, setOpen] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const id = botId ?? "";
  const discovery = {
    claude: useModelDiscovery(client, id, "claude", !!botId && defaults.engines.includes("claude") && open),
    codex: useModelDiscovery(client, id, "codex", !!botId && defaults.engines.includes("codex") && open),
    agy: useModelDiscovery(client, id, "agy", !!botId && defaults.engines.includes("agy") && open),
  };
  const toggle = (engine: EngineId, wanted: boolean) => {
    const next = wanted ? [...defaults.engines, engine] : defaults.engines.filter((candidate) => candidate !== engine);
    void change({ key: "defaultEngines", value: next as EngineId[] });
  };
  const apply = async () => {
    setApplying(true);
    setOutcome(null);
    try {
      const result = await client.request({ type: "engineDefaults.applyAll", confirmed: true });
      setOutcome(result.failed.length
        ? { ok: false, text: `Applied to ${result.applied} bots. Could not change: ${result.failed.map((failure) => `${failure.name} (${failure.reason})`).join("; ")}` }
        : { ok: true, text: `Applied to ${result.applied} bots.` });
    } catch (failure) {
      setOutcome({ ok: false, text: why(failure) });
    } finally { setApplying(false); setConfirming(false); }
  };
  const primaryName = defaults.primary ? ENGINE_NAMES[defaults.primary] : null;
  return (
    <section className="settings-group" aria-label="Engines and models">
      <h3><button type="button" className="settings-fold" aria-expanded={open} onClick={() => setOpen(!open)}><span aria-hidden="true">{open ? "▾" : "▸"}</span> Engines and models</button></h3>
      {open && <>
        <div className="settings-card">
          {(["claude", "codex", "agy"] as const).map((engine) => {
            const on = defaults.engines.includes(engine);
            return <Toggle key={engine} label={ENGINE_NAMES[engine]} checked={on} disabled={on && defaults.engines.length === 1} onChange={(wanted) => toggle(engine, wanted)} />;
          })}
          <Row label="Primary engine" hint={primaryName ? undefined : "Each bot's first engine"}>
            <SelectSetting label="Primary engine" blank="First engine of each bot" options={defaults.engines.map((engine) => ({ id: engine, label: ENGINE_NAMES[engine] }))} value={defaults.primary}
              onChange={(value) => change({ key: "defaultPrimaryEngine", value: value as EngineId | null })} />
          </Row>
          {defaults.engines.map((engine) => (
            <React.Fragment key={engine}>
            <Row label={`${ENGINE_NAMES[engine]} model`}>
              {botId
                ? <ModelPicker label={`${ENGINE_NAMES[engine]}'s default model`} discovery={discovery[engine]} value={defaults.models[engine]} onChange={(model) => change({ key: "defaultEngineModel", value: { engine, model } })} />
                : <SelectSetting label={`${ENGINE_NAMES[engine]}'s default model`} blank="Engine default" options={[]} value={defaults.models[engine]} onChange={(model) => change({ key: "defaultEngineModel", value: { engine, model } })} />}
            </Row>
            <Row label={`${ENGINE_NAMES[engine]} thinking effort`}>
              <SelectSetting label={`${ENGINE_NAMES[engine]} default thinking effort`} blank="Engine default" options={effortOptions(engine)} value={defaults.efforts[engine]}
                onChange={(value) => change({ key: "defaultEffort", value: { engine, effort: value as SettingsView["engineDefaults"]["efforts"]["claude"] } })} />
            </Row>
            </React.Fragment>
          ))}
          <Row label="Apply to all bots" hint="Sets every bot's engines, models, effort and primary engine to these. Overwrites each bot's own choices.">
            {!confirming
              ? <button type="button" disabled={applying} onClick={() => { setOutcome(null); setConfirming(true); }}>Apply to all bots…</button>
              : <span className="settings-confirm" role="alertdialog" aria-label="Confirm apply to all bots">
                  <span>Overwrite the engines, models, effort and primary engine of {botCount ? `all ${botCount} bots` : "every bot"}? Their own choices are lost.</span>
                  <button type="button" disabled={applying} onClick={() => void apply()}>{applying ? "Applying…" : "Overwrite all bots"}</button>
                  <button type="button" disabled={applying} onClick={() => setConfirming(false)}>Cancel</button>
                </span>}
          </Row>
        </div>
        <p className="settings-note">New bots start with these. A bot's own settings can override the primary engine, which is who a message goes to unless you pick another in the composer. Running heads switch model at their next wake.</p>
        {outcome && <p className={outcome.ok ? "settings-hint" : "settings-problem"} role={outcome.ok ? "status" : "alert"}>{outcome.text}</p>}
      </>}
    </section>
  );
}

function Engines({ client, settings, change, codexModels, modelBotId, botCount }: { client: Client; settings: SettingsView; change: (next: SettingsChange) => Promise<boolean>; codexModels: CodexModelOption[]; modelBotId: string | null; botCount: number }) {
  const workers = settings.codexWorkers;
  const following = settings.codexWorkersFollow;
  return (
    <>
      <EngineDefaults client={client} settings={settings} change={change} botId={modelBotId} botCount={botCount} />
      <AntigravityRuntime client={client} settings={settings} change={change} />
      <Group title="Engine permissions" note="Applies when an engine process next starts, including resumed sessions and its workers. Running sessions keep their current mode: let work finish, then restart the app to apply changes. No new conversation is required. App-specific approvals and server policies remain in force.">
        <p className="settings-hint">Auto mode instructs the engines to allow low/medium-risk actions automatically and ask for human approval of high-risk actions. Engine classification is not guaranteed; hard denies and managed policies still apply. Unknown risk, review failures and OS/sandbox blocks are not auto-approved.</p>
        <Toggle label="Claude: bypass permission checks" hint="Skips Claude tool permission checks for sessions and Claude workers. Protected paths, explicit tool restrictions, managed policy and OS protections still apply." checked={settings.claudeBypassPermissions} onChange={(value) => change({ key: "claudeBypassPermissions", value })} />
        <Toggle label="Codex: bypass approvals and sandbox" hint="Disables Codex approval prompts, auto review and its filesystem/network sandbox for sessions and Codex workers. Commands run with the app user's OS access." checked={settings.codexBypassPermissions} onChange={(value) => change({ key: "codexBypassPermissions", value })} />
      </Group>
      <AntigravityPermissions client={client} settings={settings} change={change} />
      <Group title="Claude subagents" note="Takes effect when a bot next wakes.">
        <Row label="Model">
          <SelectSetting label="Subagents' model" blank="Same as bot" options={MODELS} value={settings.subagentModel}
            onChange={(value) => change({ key: "subagentModel", value: value as SettingsView["subagentModel"] })} />
        </Row>
        <Toggle label="Keep subagents' prompt cache for 1 hour" checked={settings.subagentHourCache} onChange={(value) => change({ key: "subagentHourCache", value })} />
      </Group>
      <Group title="Codex workers" note="Takes effect when a Codex head next wakes.">
        <p className="settings-hint">In effect: {following ? "as ~/.codex/config.toml says" : `${workers.model ?? "same as bot"} · ${EFFORTS.find((effort) => effort.id === workers.effort)?.label ?? "default effort"} · ${workers.fast ? "Fast" : "Standard"}`}</p>
        <Toggle label="Follow Codex config file" hint="~/.codex/config.toml" checked={following} onChange={(value) => change({ key: "codexWorkersFollow", value })} />
        <Row label="Model">
          <SelectSetting label="Workers' model" blank="Same as bot" options={codexOptions(codexModels)} value={workers.model} disabled={following} onChange={(value) => change({ key: "codexWorkers", value: { ...workers, model: value } })} />
        </Row>
        <Row label="Reasoning effort">
          <SelectSetting label="Workers' reasoning effort" blank="Default effort" options={EFFORTS} value={workers.effort} disabled={following} onChange={(value) => change({ key: "codexWorkers", value: { ...workers, effort: value as SettingsView["codexWorkers"]["effort"] } })} />
        </Row>
        <Toggle label="Fast mode" hint="service_tier = priority: faster replies, uses more of your limits" checked={!!workers.fast} disabled={following} onChange={(value) => change({ key: "codexWorkers", value: { ...workers, fast: value } })} />
      </Group>
      <Group title="Completion verification" note="After a reply, an isolated Codex judge checks whether the authorized task is done; unfinished work is continued (twice without progress: paused). Uses your Codex login.">
        <Toggle label="Verify completion automatically" checked={settings.completionVerification} onChange={(value) => change({ key: "completionVerification", value })} />
        <Row label="Verification model" hint={`Current verification model: ${settings.completionVerificationModel}`}>
          <SelectSetting label="Verification model" options={codexOptions(codexModels)} value={settings.completionVerificationModel} disabled={!settings.completionVerification} onChange={(value) => change({ key: "completionVerificationModel", value })} />
        </Row>
      </Group>
      <Group title="Component editor" note="Maintainer's component editor; written into the plugin library when the app next starts.">
        <Row label="Model">
          <SelectSetting label="Component editor's model" options={MODELS} value={settings.componentEditorModel} onChange={(value) => { if (value) change({ key: "componentEditorModel", value: value as SettingsView["componentEditorModel"] }); }} />
        </Row>
      </Group>
    </>
  );
}

/** The shown bot's own choices, for the right panel's settings page (1.x's SettingsPage in DetailPanel). */
export function BotSettings({ client, bot }: { client: Client; bot: BotView }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      {problem && <p className="settings-problem" role="alert">{problem}</p>}
      <ThisBot key={bot.id} client={client} bot={bot} onProblem={setProblem} />
    </>
  );
}

function ThisBot({ client, bot, onProblem }: { client: Client; bot: BotView; onProblem: (problem: string | null) => void }) {
  const [view, setView] = useState<BotSettingsView | null>(null);
  const claudeModels = useModelDiscovery(client, bot.id, "claude", (view?.engines ?? bot.heads).includes("claude"));
  const codexModels = useModelDiscovery(client, bot.id, "codex", (view?.engines ?? bot.heads).includes("codex"));
  const agyModels = useModelDiscovery(client, bot.id, "agy", (view?.engines ?? bot.heads).includes("agy"));
  useEffect(() => { void client.request({ type: "bot.settings", botId: bot.id }).then(setView, (failure) => onProblem(why(failure))); }, [client, bot.id, bot.heads.length, onProblem]);
  const configure = (change: Omit<Extract<import("../contract").Command, { type: "bot.configure" }>, "type" | "botId">) => {
    onProblem(null);
    void client.request({ type: "bot.configure", botId: bot.id, ...change }).then(setView, (failure) => onProblem(why(failure)));
  };
  const setHeads = (engines: ("claude" | "codex" | "agy")[]) => {
    onProblem(null);
    void client.request({ type: "heads.set", botId: bot.id, engines }).then(() => client.request({ type: "bot.settings", botId: bot.id })).then(setView, (failure) => onProblem(why(failure)));
  };
  if (!view) return null;
  const two = view.engines.length > 1;
  const hasClaude = view.engines.includes("claude");
  const hasCodex = view.engines.includes("codex");
  const hasAgy = view.engines.includes("agy");
  // Each engine has its own effort (the old single one shows for an engine that has none of its own).
  const effortRow = (engine: "claude" | "codex" | "agy") => (
    <Row label="Thinking effort">
      <SelectSetting label={`${ENGINE_NAMES[engine]} thinking effort`} blank="Default" options={effortOptions(engine)} value={view.efforts?.[engine] ?? view.effort ?? null}
        onChange={(value) => configure({ efforts: { [engine]: value as BotSettingsView["effort"] } })} />
    </Row>
  );
  return (
    <>
      <Group title="Engines in this bot" note="Choose a primary recipient in the composer. Enabled engines can collaborate when needed. Antigravity requires the verified official ACP runtime and Google sign-in.">
        {(["claude", "codex", "agy"] as const).map((engine) => {
          const on = view.engines.includes(engine);
          const name = engine === "agy" ? "Antigravity" : engine === "claude" ? "Claude" : "Codex";
          // 1.x's "Engines in this bot": the only head cannot go; turning off the first of two runs the bot on the other, through a handoff.
          return (
            <Toggle key={engine} label={name} checked={on} disabled={bot.phase === "switching" || (on && !two)}
              onChange={(wanted) => setHeads(wanted ? [...view.engines, engine] : view.engines.filter((candidate) => candidate !== engine))} />
          );
        })}
      </Group>
      {two && (
        <Group title="Primary engine" note="Who a message goes to unless you pick another in the composer. By default a bot follows the app's setting (Settings → Engines and models).">
          <Row label="Primary engine">
            <SelectSetting label="Primary engine" blank={`Follow app default (${ENGINE_NAMES[view.primaryEffective ?? view.engines[0]!]})`} options={view.engines.map((engine) => ({ id: engine, label: ENGINE_NAMES[engine] }))} value={view.primary ?? null}
              onChange={(value) => configure({ primary: value as BotSettingsView["engines"][number] | null })} />
          </Row>
        </Group>
      )}
      {hasClaude && (
        <Group title="Claude">
          <Row label="Model">
            <ModelPicker label="Claude's model" discovery={claudeModels} value={view.model} onChange={(model) => configure({ model })} />
          </Row>
          {effortRow("claude")}
          <Row label="Subagents' model">
            <ModelPicker label="Claude subagents' model" blank="Inherit bot" discovery={claudeModels} value={view.subagentModel} subagents onChange={(subagentModel) => configure({ subagentModel })} />
          </Row>
        </Group>
      )}
      {hasCodex && (
        <Group title="Codex">
          <Row label="Model">
            <ModelPicker label="Codex's model" discovery={codexModels} value={view.codexModel} onChange={(codexModel) => configure({ codexModel })} />
          </Row>
          {effortRow("codex")}
        </Group>
      )}
      {hasAgy && <Group title="Antigravity" note="ACP uses single-action approval cards and app-managed tools. Native agents, workflows and global plugins are disabled.">
        <Row label="Model">
          <ModelPicker label="Antigravity model" discovery={agyModels} value={view.agyModel ?? null} onChange={(agyModel) => configure({ agyModel })} />
        </Row>
        {effortRow("agy")}
      </Group>}
    </>
  );
}

function Results({ settings, change }: { settings: SettingsView; change: (next: SettingsChange) => void }) {
  return (
    <Group title="Reports and results" note="What a bot does with a report or a page it made.">
      <Row label="Publish as">
        <select aria-label="Publish as" value={settings.resultPublishing} onChange={(event) => change({ key: "resultPublishing", value: event.target.value as SettingsView["resultPublishing"] })}>
          <option value="artifactUnlessSensitive">Artifact, sensitive ones local</option>
          <option value="localOnly">Always a local HTML page</option>
          <option value="artifactAlways">Always an Artifact</option>
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
