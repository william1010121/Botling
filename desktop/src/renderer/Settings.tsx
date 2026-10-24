// The Settings window (1.x's SettingsWindow.swift) as a sheet over the app: its sections in 1.x's order
// and words, for what 2.0's core does. Everything here is global (settings.json) except "This bot",
// which is the shown bot's own bot.json (1.x keeps those on the bot's page beside the chat). Each
// control shows what the core saved: a change goes out, the answer (or `settings.updated`) comes back.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { BotSettingsView, BotView, PluginsView, SettingsChange, SettingsView } from "../contract";
import { Client, RequestFailed } from "./client";
import { PanelFrame, PluginsPanel } from "./Plugins";
import { faceURL } from "./avatars";

const why = (failure: unknown) => (failure instanceof RequestFailed ? failure.error.message : String((failure as Error)?.message ?? failure));

type Section = "general" | "engines" | "bot" | "permissions" | "plugins";
const SECTIONS: { id: Section; title: string; terms: string }[] = [
  { id: "general", title: "General", terms: "language bot look cute original chat avatars size summaries catch-up unread interval threshold prompt model reminders" },
  { id: "engines", title: "Engines and subagents", terms: "claude subagents model prompt cache hour codex workers config effort fast completion verification component editor" },
  { id: "bot", title: "This bot", terms: "engine heads claude codex model effort subagents" },
  { id: "permissions", title: "Reports and results", terms: "publish artifact local html results reports" },
  { id: "plugins", title: "Plugins", terms: "plugins extensions settings secrets commands panels" },
];

const LANGUAGES: { id: SettingsView["language"]; label: string }[] = [
  { id: null, label: "System default" }, { id: "en", label: "English" }, { id: "zh-Hant", label: "繁體中文" },
  { id: "zh-Hans", label: "简体中文" }, { id: "ja", label: "日本語" }, { id: "ko", label: "한국어" },
];
const MODELS = [{ id: "haiku", label: "Haiku" }, { id: "sonnet", label: "Sonnet" }, { id: "opus", label: "Opus" }] as const;
const EFFORTS = [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "xhigh", label: "Extra high" }, { id: "max", label: "Max" }] as const;
const STALL = [5, 10, 15, 30, 60, 0];

export function SettingsSheet({ client, settings, bot, plugins, onClose }: { client: Client; settings: SettingsView | null; bot: BotView | null; plugins: PluginsView | null; onClose: () => void }) {
  const [section, setSection] = useState<Section>("general");
  const [search, setSearch] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<SettingsView | null>(settings);
  useEffect(() => { if (settings) setShown(settings); }, [settings]);
  useEffect(() => { if (!settings) void client.request({ type: "settings.get" }).then(setShown, (failure) => setProblem(why(failure))); }, [client, settings]);
  const change = useCallback((next: SettingsChange) => {
    setProblem(null);
    void client.request({ type: "settings.set", change: next }).then(setShown, (failure) => setProblem(why(failure)));
  }, [client]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const sections = useMemo(() => {
    const words = search.trim().toLowerCase();
    return SECTIONS.filter((entry) => (entry.id !== "bot" || bot) && (!words || `${entry.title} ${entry.terms}`.toLowerCase().includes(words)));
  }, [search, bot]);
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
            {shown && current?.id === "engines" && <Engines settings={shown} change={change} />}
            {current?.id === "bot" && bot && <ThisBot client={client} bot={bot} onProblem={setProblem} />}
            {shown && current?.id === "permissions" && <Results settings={shown} change={change} />}
            {current?.id === "plugins" && <PluginsSection client={client} plugins={plugins} />}
          </div>
        </section>
      </div>
    </div>
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

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
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
      <Group title="Reminders" note="2.0 keeps this choice; the reminder itself is not in 2.0 yet.">
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
      <Group title="Completion verification" note="2.0 keeps this choice; checking whether a reply finished what it promised is not in 2.0 yet.">
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

/** The shown bot's own choices (1.x: the bot's settings beside its chat). */
function ThisBot({ client, bot, onProblem }: { client: Client; bot: BotView; onProblem: (problem: string | null) => void }) {
  const [view, setView] = useState<BotSettingsView | null>(null);
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
  const first = view.engines[0]!;
  const other = first === "claude" ? "codex" : "claude";
  const two = view.engines.length > 1;
  const hasClaude = view.engines.includes("claude");
  const hasCodex = view.engines.includes("codex");
  return (
    <>
      <Group title={bot.name} note="A head already awake keeps its model until the bot next wakes.">
        <Row label="Heads" hint={`Its first head is ${first === "claude" ? "Claude" : "Codex"}; it stays.`}>
          <Segmented label="Heads" options={[{ id: "one", label: first === "claude" ? "Claude" : "Codex" }, { id: "two", label: "Claude & Codex" }] as const}
            value={two ? "two" : "one"} onChange={(value) => setHeads(value === "two" ? [first, other] : [first])} />
        </Row>
        {hasClaude && (
          <Row label="Claude's model">
            <Segmented label="Claude's model" options={[{ id: "default", label: "Default" }, ...MODELS] as const} value={view.model ?? "default"} onChange={(value) => configure({ model: value === "default" ? null : value })} />
          </Row>
        )}
        <Row label="Reasoning effort" hint="Max is Codex's Extra high.">
          <Segmented label="Reasoning effort" options={[{ id: "default", label: "Default" }, ...EFFORTS] as const} value={view.effort ?? "default"} onChange={(value) => configure({ effort: value === "default" ? null : value })} />
        </Row>
        {hasClaude && (
          <Row label="Subagents' model">
            <Segmented label="This bot's subagents' model" options={[{ id: "same", label: "As in Settings" }, ...MODELS] as const} value={view.subagentModel ?? "same"} onChange={(value) => configure({ subagentModel: value === "same" ? null : value })} />
          </Row>
        )}
        {hasCodex && (
          <Row label="Codex's model">
            <TextSetting label="Codex's model" value={view.codexModel} placeholder="Codex's default model" onSave={(value) => configure({ codexModel: value })} />
          </Row>
        )}
      </Group>
    </>
  );
}

function Results({ settings, change }: { settings: SettingsView; change: (next: SettingsChange) => void }) {
  return (
    <Group title="Reports and results" note="What a bot does with a report or a page it made (its instructions say so).">
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
