import { DoctorSection } from "./Doctor";
import { postToChat } from "./editor-surface";
import { UpdateActions,RecoveryCopies } from "./Updates";
// The Settings window (1.x's SettingsWindow.swift) as a sheet over the app: its sections in 1.x's order
// and words, for what 2.0's core does. Everything here is global (settings.json); the shown bot's own
// choices (its bot.json) are `BotSettings`, in the right panel one level in, as in 1.x. Each
// control shows what the core saved: a change goes out, the answer (or `settings.updated`) comes back.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BotSettingsView, BotView, PluginsView, SettingsChange, SettingsView, UpdateView, UsageView } from "../contract";
import { asOf, countdown, dollars, isEmpty, percent, resetDay, staleSince, tokenCount, type Limits } from "./usage-text";
import { MESSAGE_WIDTH_DEFAULT, MESSAGE_WIDTH_MIN, MESSAGE_WIDTH_MAX } from "../contract/message-width";
import { Client, RequestFailed } from "./client";
import { PanelFrame, PluginsPanel } from "./Plugins";
import { faceURL } from "./avatars";

const why = (failure: unknown) => (failure instanceof RequestFailed ? failure.error.message : String((failure as Error)?.message ?? failure));

export type SettingsSection = "general" | "appearance" | "engines" | "usage" | "permissions" | "plugins" | "doctor" | "updates" | "developer";
type Section = SettingsSection;
const SECTIONS: { id: Section; title: string; terms: string }[] = [
  { id: "general", title: "General", terms: "language bot look cute original chat avatars size summaries catch-up unread interval threshold prompt model reminders" },
  { id: "appearance", title: "Appearance", terms: "message column width chat composer size reset" },
  { id: "engines", title: "Engines and subagents", terms: "claude subagents model prompt cache hour codex workers config effort fast completion verification component editor" },
  { id: "usage", title: "Usage", terms: "usage cost tokens spending today by bot earlier days subscription limits rate 5 hours week claude codex" },
  { id: "permissions", title: "Reports and results", terms: "publish artifact local html results reports" },
  { id: "plugins", title: "Plugins", terms: "plugins extensions settings secrets commands panels" },
  { id: "doctor", title: "Doctor", terms: "command-line tools claude codex install version login sign in check health" },
  { id: "updates", title: "Updates", terms: "updates version release github check new" },
  { id: "developer", title: "Developer", terms: "developer mode source project feedback not right" },
];

const LANGUAGES: { id: SettingsView["language"]; label: string }[] = [
  { id: null, label: "System default" }, { id: "en", label: "English" }, { id: "zh-Hant", label: "繁體中文" },
  { id: "zh-Hans", label: "简体中文" }, { id: "ja", label: "日本語" }, { id: "ko", label: "한국어" },
];
const MODELS = [{ id: "haiku", label: "Haiku" }, { id: "sonnet", label: "Sonnet" }, { id: "opus", label: "Opus" }] as const;
const EFFORTS = [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "xhigh", label: "Extra high" }, { id: "max", label: "Max" }] as const;
const STALL = [5, 10, 15, 30, 60, 0];

export function SettingsSheet({ client, settings, bot, bots = [], plugins, initialSection = "general", onClose }: { client: Client; settings: SettingsView | null; bot: BotView | null; bots?: BotView[]; plugins: PluginsView | null; initialSection?: SettingsSection; onClose: () => void }) {
  const [section, setSection] = useState<Section>(initialSection);
  const [search, setSearch] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<SettingsView | null>(settings);
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
    <div className="settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
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
            {shown && current?.id === "general" && <General settings={shown} change={change} bot={bot} />}
            {shown && current?.id === "appearance" && <Appearance settings={shown} change={change} />}
            {shown && current?.id === "engines" && <Engines settings={shown} change={change} />}
            {current?.id === "usage" && <Usage client={client} />}
            {shown && current?.id === "permissions" && <Results settings={shown} change={change} />}
            {current?.id === "plugins" && <PluginsSection client={client} plugins={plugins} />}
            {current?.id === "doctor" && <DoctorSection client={client} />}
            {shown && current?.id === "updates" && <Updates client={client} settings={shown} change={change} />}
            {shown && current?.id === "developer" && <Developer settings={shown} change={change} bots={bots} />}
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * Settings → Usage (1.x's usage page, Phase 5c): cost and tokens today, the subscriptions' limits as Claude and
 * Codex last reported them (they come with bots' turns only), by bot, and the days before. Read again each minute.
 */
function Usage({ client }: { client: Client }) {
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true, pending = false;
    const load = () => {
      if (pending) return;
      pending = true;
      setLoading(true);
      setNow(Date.now());
      void client.request({ type: "usage.view" }).then(value => {
        if (live) { setUsage(value); setFailed(false); }
      }, () => { if (live) setFailed(true); }).finally(() => {
        pending = false;
        if (live) setLoading(false);
      });
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => { live = false; clearInterval(timer); };
  }, [client, retry]);
  const tokens = usage?.tokens;
  const available = usage?.spendingStatus === "available";
  return (
    <>
      {loading && !usage && <p className="settings-note" role="status">Loading usage…</p>}
      {failed && <div className="settings-note" role="alert">
        Usage is unavailable.{" "}
        <button type="button" disabled={loading} onClick={() => setRetry(value => value + 1)}>Retry</button>
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

/** Settings → Updates: discovery, verification, explicit restart. */
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
      <RecoveryCopies client={client} />
    </Group>
  );
}

/**
 * Developer mode (1.x's Settings → Developer): one project is Botling's own source and gets what you flag as
 * "not right" in any chat, with the chat around it; its manager may install builds it made (you confirm on a card in
 * the main bot's chat) and see the app's window (core/self-update.ts).
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

/** A text field that saves on Enter or when it loses focus (empty: the default). */
function TextSetting({ label, value, placeholder, onSave, disabled }: { label: string; value: string | null; placeholder?: string; onSave: (value: string | null) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  const save = () => { const next = draft.trim() || null; if (next !== (value ?? null)) onSave(next); };
  return <input type="text" aria-label={label} value={draft} placeholder={placeholder} disabled={disabled} onChange={(event) => setDraft(event.target.value)} onBlur={save} onKeyDown={(event) => { if (event.key === "Enter") save(); }} />;
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

function General({ settings, change, bot }: { settings: SettingsView; change: (next: SettingsChange) => void; bot: BotView | null }) {
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
          <TextSetting label="Summary model" value={settings.catchUpModel} placeholder="gpt-6-luna" onSave={(value) => change({ key: "catchUpModel", value })} />
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

function Engines({ settings, change }: { settings: SettingsView; change: (next: SettingsChange) => void }) {
  const workers = settings.codexWorkers;
  const following = settings.codexWorkersFollow;
  return (
    <>
      <Group title="Claude subagents" note="Takes effect when a bot next wakes.">
        <Row label="Model">
          <Segmented label="Subagents' model" options={[{ id: "same", label: "Same as bot" }, ...MODELS] as const}
            value={settings.subagentModel ?? "same"} onChange={(value) => change({ key: "subagentModel", value: value === "same" ? null : value })} />
        </Row>
        <Toggle label="Keep subagents' prompt cache for 1 hour" checked={settings.subagentHourCache} onChange={(value) => change({ key: "subagentHourCache", value })} />
      </Group>
      <Group title="Codex workers" note="Takes effect when a Codex head next wakes.">
        <p className="settings-hint">In effect: {following ? "as ~/.codex/config.toml says" : `${workers.model ?? "same as bot"} · ${EFFORTS.find((effort) => effort.id === workers.effort)?.label ?? "default effort"} · ${workers.fast ? "Fast" : "Standard"}`}</p>
        <Toggle label="Follow Codex config file" hint="~/.codex/config.toml" checked={following} onChange={(value) => change({ key: "codexWorkersFollow", value })} />
        <Row label="Model">
          <TextSetting label="Workers' model" value={workers.model} placeholder="Same as bot" disabled={following} onSave={(value) => change({ key: "codexWorkers", value: { ...workers, model: value } })} />
        </Row>
        <Row label="Reasoning effort">
          <Segmented label="Workers' reasoning effort" options={EFFORTS} value={workers.effort} disabled={following} onChange={(value) => change({ key: "codexWorkers", value: { ...workers, effort: value } })} />
        </Row>
        <Toggle label="Fast mode" hint="service_tier = priority: faster replies, uses more of your limits" checked={!!workers.fast} disabled={following} onChange={(value) => change({ key: "codexWorkers", value: { ...workers, fast: value } })} />
      </Group>
      <Group title="Completion verification" note="After a reply, an isolated Codex judge checks whether the authorized task is done; unfinished work is continued (twice without progress: paused). Uses your Codex login.">
        <Toggle label="Verify completion automatically" checked={settings.completionVerification} onChange={(value) => change({ key: "completionVerification", value })} />
        <Row label="Verification model" hint={`Current verification model: ${settings.completionVerificationModel}`}>
          <TextSetting label="Verification model" value={settings.completionVerificationModel} disabled={!settings.completionVerification} onSave={(value) => change({ key: "completionVerificationModel", value })} />
        </Row>
      </Group>
      <Group title="Component editor" note="Maintainer's component editor; written into the plugin library when the app next starts.">
        <Row label="Model">
          <Segmented label="Component editor's model" options={MODELS} value={settings.componentEditorModel} onChange={(value) => change({ key: "componentEditorModel", value })} />
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
      <ThisBot client={client} bot={bot} onProblem={setProblem} />
    </>
  );
}

function ThisBot({ client, bot, onProblem }: { client: Client; bot: BotView; onProblem: (problem: string | null) => void }) {
  const [view, setView] = useState<BotSettingsView | null>(null);
  const [models, setModels] = useState<{ id: string; name: string; isDefault: boolean }[]>([]);
  const codexHead = bot.heads.includes("codex");
  useEffect(() => { if (codexHead) void client.request({ type: "codex.models" }).then((result) => setModels(result.models), () => setModels([])); }, [client, codexHead]);
  useEffect(() => { void client.request({ type: "bot.settings", botId: bot.id }).then(setView, (failure) => onProblem(why(failure))); }, [client, bot.id, bot.heads.length, onProblem]);
  const configure = (change: Omit<Extract<import("../contract").Command, { type: "bot.configure" }>, "type" | "botId">) => {
    onProblem(null);
    void client.request({ type: "bot.configure", botId: bot.id, ...change }).then(setView, (failure) => onProblem(why(failure)));
  };
  const setHeads = (engines: ("claude" | "codex")[]) => {
    onProblem(null);
    void client.request({ type: "heads.set", botId: bot.id, engines }).then(() => client.request({ type: "bot.settings", botId: bot.id })).then(setView, (failure) => onProblem(why(failure)));
  };
  if (!view) return null;
  const two = view.engines.length > 1;
  const hasClaude = view.engines.includes("claude");
  const hasCodex = view.engines.includes("codex");
  return (
    <>
      <Group title="Engines in this bot" note="With both, they work at the same time. Turning off the one it runs on hands its work to the other through memory.md, just before its next message.">
        {(["claude", "codex"] as const).map((engine) => {
          const on = view.engines.includes(engine);
          const name = engine === "claude" ? "Claude" : "Codex";
          // 1.x's "Engines in this bot": the only head cannot go; turning off the first of two runs the bot on the other, through a handoff.
          return (
            <Toggle key={engine} label={name} checked={on} disabled={bot.phase === "switching" || (on && !two)}
              onChange={(wanted) => setHeads(wanted ? [...view.engines, engine] : view.engines.filter((candidate) => candidate !== engine))} />
          );
        })}
      </Group>
      <Group title={bot.name} note="A head already awake goes on in the same conversation on the new choice just before its next message.">
        {hasClaude && (
          <Row label="Claude's model">
            <Segmented label="Claude's model" options={[{ id: "default", label: "Default" }, ...MODELS] as const} value={view.model ?? "default"} onChange={(value) => configure({ model: value === "default" ? null : value })} />
          </Row>
        )}
        <Row label="Reasoning effort">
          <Segmented label="Reasoning effort" options={[{ id: "default", label: "Default" }, ...EFFORTS] as const} value={view.effort ?? "default"} onChange={(value) => configure({ effort: value === "default" ? null : value })} />
        </Row>
        {hasClaude && (
          <Row label="Subagents' model">
            <Segmented label="This bot's subagents' model" options={[{ id: "same", label: "As in Settings" }, ...MODELS] as const} value={view.subagentModel ?? "same"} onChange={(value) => configure({ subagentModel: value === "same" ? null : value })} />
          </Row>
        )}
        {hasCodex && (
          <Row label="Codex's model">
            {models.length ? (
              <select aria-label="Codex's model" value={view.codexModel ?? ""} onChange={(event) => configure({ codexModel: event.target.value || null })}>
                <option value="">Codex's default model</option>
                {models.map((model) => <option key={model.id} value={model.id}>{model.name}{model.isDefault ? " (default)" : ""}</option>)}
                {view.codexModel && !models.some((model) => model.id === view.codexModel) && <option value={view.codexModel}>{view.codexModel}</option>}
              </select>
            ) : <TextSetting label="Codex's model" value={view.codexModel} placeholder="Codex's default model" onSave={(value) => configure({ codexModel: value })} />}
          </Row>
        )}
      </Group>
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
