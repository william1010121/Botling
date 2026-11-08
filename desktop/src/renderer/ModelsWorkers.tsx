// Settings → Models & workers: the one place for which model does what. Pick an engine (Claude | Codex | Antigravity)
// and see only its defaults: a Bot head × Workers table of model and effort, with a short model guide; then what new
// bots start with, one folded line for the bots that use their own settings (changed in each bot's panel), and the
// special jobs (summaries, the component editor, who may change spec/). The defaults reach bots as before: new bots
// start with them, and the workers' ones go to every bot when changed (server.ts).
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { BotSettingsView, BotView, PluginsView, SettingsChange, SettingsView } from "../contract";
import type { Client } from "./client";
import { useModelDiscovery } from "./ModelPicker";
import { workerLimitWords } from "./worker-limit-text";
import { CLAUDE_MODELS, EFFORTS, EffortControl, Group, ModelSelect, Row, SelectSetting, Toggle, why } from "./settings-controls";
import { choiceLabel, defaultsChange, ENGINE_NAMES, ownChoices, tokensLabel, type EngineId } from "./bot-defaults";
import { SummaryModelRow, type CodexModelOption } from "./chat-summaries";
import type { SettingsSection } from "./settings-pages";

type Change = (next: SettingsChange) => Promise<boolean>;
const WORKER_LIMITS = Array.from({ length: 16 }, (_, i) => i + 1);

/** The model guide: relative cost, speed and what each Claude model is good for. */
export const CLAUDE_GUIDE = [
  { id: "haiku", name: "Haiku", detail: "haiku", cost: "$", speed: "fastest", good: "Quick lookups, small edits, summaries." },
  { id: "sonnet", name: "Sonnet", detail: "sonnet", cost: "$$", speed: "fast", good: "Everyday coding and research. A good worker choice." },
  { id: "opus", name: "Opus", detail: "opus · Claude Opus 5.5", cost: "$$$", speed: "slower", good: "Hard problems and planning. Native 1M window, same price as opus[1m]." },
] as const;
const CLAUDE_HINT: Record<string, string> = {
  haiku: "Claude Haiku · fastest, lowest cost",
  sonnet: "Claude Sonnet · fast, a good balance of cost and strength",
  opus: "Claude Opus 5.5 · 1M-token window · strongest, highest cost",
};
const WHEN: Record<EngineId, string> = {
  claude: "Head: next wake · Workers: next one that starts",
  codex: "Both: when a Codex head next wakes",
  agy: "Head: next Antigravity launch · Workers: next one that starts",
};
const effortName = (id: string | null | undefined) => EFFORTS.find((effort) => effort.id === id)?.label ?? id ?? null;

export function ModelsWorkers({ client, settings, change, bots, modelBotId, codexModels, plugins, onProblem, onNavigate, onOpenBot }: {
  client: Client; settings: SettingsView; change: Change; bots: BotView[]; modelBotId: string | null; codexModels: CodexModelOption[];
  plugins: PluginsView | null; onProblem: (problem: string | null) => void; onNavigate: (section: SettingsSection) => void; onOpenBot?: (botId: string) => void;
}) {
  const defaults = settings.engineDefaults;
  const [engine, setEngine] = useState<EngineId>(defaults.engines[0] ?? "claude");
  const id = modelBotId ?? "";
  const discovery = {
    claude: useModelDiscovery(client, id, "claude", !!modelBotId && engine === "claude"),
    codex: useModelDiscovery(client, id, "codex", !!modelBotId && engine === "codex"),
    agy: useModelDiscovery(client, id, "agy", !!modelBotId && engine === "agy"),
  };
  return (
    <div className="models-workers">
      <div className="mw-explain">
        <div className="mw-explain-card">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mw-icon-head"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z" /></svg>
          <div><strong>Bot head</strong><p>Talks with you in the chat, plans, and hands work off.</p></div>
        </div>
        <div className="mw-explain-card">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mw-icon-workers"><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
          <div><strong>Workers</strong><p>Do the handed-off task in the background, several at once. Claude calls them subagents.</p></div>
        </div>
      </div>
      <div className="mw-picker">
        <div className="mw-tabs" role="tablist" aria-label="Engine">
          {(["claude", "codex", "agy"] as const).map((one) => (
            <button key={one} type="button" role="tab" aria-selected={engine === one} className={engine === one ? "on" : ""} onClick={() => setEngine(one)}>
              {ENGINE_NAMES[one]}{!defaults.engines.includes(one) && <span className="mw-tab-note"> · not in new bots</span>}
            </button>
          ))}
        </div>
        <span className="settings-hint">Defaults for bots that use this engine · {WHEN[engine]}</span>
      </div>
      {engine === "claude" && <ClaudeTable settings={settings} change={change} discovery={discovery.claude.result} />}
      {engine === "codex" && <CodexTable settings={settings} change={change} discovery={discovery.codex.result} codexModels={codexModels} />}
      {engine === "agy" && <AgyTable client={client} settings={settings} change={change} discovery={discovery.agy.result} onNavigate={onNavigate} />}
      <p className="settings-note">Effort: higher thinks longer — better on hard problems, slower, and uses more of your limits. Only the levels this engine supports are shown.</p>
      <NewBots client={client} settings={settings} change={change} bots={bots} onOpenBot={onOpenBot} />
      <Group title="Special jobs">
        <SummaryModelRow client={client} plugins={plugins} codexModels={codexModels} modelBotId={modelBotId} onProblem={onProblem} onOptions={() => onNavigate("chat")} />
        <Row label="Component editor" hint="The maintainer’s plugin editor. Applies when the app next starts.">
          <SelectSetting label="Component editor's model" options={CLAUDE_MODELS} value={settings.componentEditorModel} onChange={(value) => { if (value) void change({ key: "componentEditorModel", value: value as SettingsView["componentEditorModel"] }); }} />
        </Row>
        <Row label="May change spec/" hint="Workers on other models can read spec/ but not write it. From settings.json (specWriters).">
          <span className="mw-chips">{(settings.specWriters ?? ["opus"]).map((writer) => <span key={writer} className="settings-tag">{writer}</span>)}</span>
        </Row>
      </Group>
    </div>
  );
}

/** One head × workers table: a header row, then labelled rows of two cells. */
function Table({ label, workersHead, rows, footer }: { label: string; workersHead?: React.ReactNode; rows: { label: string; head: React.ReactNode; workers: React.ReactNode }[]; footer?: React.ReactNode }) {
  return (
    <section className="mw-card" aria-label={label}>
      <div className="mw-table" role="table" aria-label={`${label}: head and workers`}>
        <div className="mw-row mw-row-head" role="row"><span role="columnheader" /><span role="columnheader">Bot head</span><span role="columnheader" className="mw-workers-head">Workers{workersHead}</span></div>
        {rows.map((row) => (
          <div key={row.label} className="mw-row" role="row">
            <span role="rowheader" className="mw-row-label">{row.label}</span>
            <div role="cell" className="mw-cell">{row.head}</div>
            <div role="cell" className="mw-cell">{row.workers}</div>
          </div>
        ))}
      </div>
      {footer}
    </section>
  );
}

const Hint = ({ children }: { children: React.ReactNode }) => <div className="settings-hint">{children}</div>;

function ClaudeTable({ settings, change, discovery }: { settings: SettingsView; change: Change; discovery: import("../contract/model-discovery").ModelDiscovery | null }) {
  const defaults = settings.engineDefaults;
  const head = defaults.models.claude;
  const headName = head ? choiceLabel("claude", "model", head) : "Claude default";
  const limit = workerLimitWords(settings.effectiveLanguage);
  const compact = settings.claudeAutoCompactWindow;
  return (
    <Table label="Claude" rows={[
      { label: "Model",
        head: <><ModelSelect label="Claude head model" blank="Claude default" options={CLAUDE_MODELS} discovery={discovery} value={head} onChange={(model) => void change({ key: "defaultEngineModel", value: { engine: "claude", model } })} />
          <Hint>{head ? CLAUDE_HINT[head] ?? head : "The model your Claude Code account uses by default."}</Hint></>,
        workers: <><SelectSetting label="Claude workers model" blank={`Same as head (${headName})`} options={CLAUDE_MODELS} value={settings.subagentModel} onChange={(value) => void change({ key: "subagentModel", value: value as SettingsView["subagentModel"] })} />
          <Hint>{settings.subagentModel ? CLAUDE_HINT[settings.subagentModel] : "Pick Sonnet to make routine work cheaper and faster."}</Hint></> },
      { label: "Effort",
        head: <><EffortControl label="Claude head effort" engine="claude" blank="Default" value={defaults.efforts.claude} onChange={(effort) => void change({ key: "defaultEffort", value: { engine: "claude", effort } })} />
          <Hint>{defaults.efforts.claude ? `${effortName(defaults.efforts.claude)} · ${defaults.efforts.claude === "low" ? "answers quickly" : "thinks carefully before answering"}` : "Claude Code’s own default"}</Hint></>,
        workers: <><EffortControl label="Claude workers effort" engine="claude" blank="Same" value={settings.subagentEffort ?? null} onChange={(effort) => void change({ key: "subagentEffort", value: effort })} />
          <Hint>{settings.subagentEffort ? effortName(settings.subagentEffort) : "Same as head · or lower for quick jobs"}</Hint></> },
    ]} footer={<>
      <div className="mw-guide">
        {CLAUDE_GUIDE.map((model) => (
          <div key={model.id} className={`mw-guide-card${head === model.id ? " on" : ""}`}>
            <div className="mw-guide-top"><strong>{model.name}</strong><span>{model.cost}</span></div>
            <div className="settings-hint">{model.detail}</div>
            <div className="mw-guide-good">{model.good}</div>
            <div className="settings-hint">Speed: {model.speed}</div>
          </div>
        ))}
      </div>
      <div className="mw-rows">
        <Row label={limit.label} hint={limit.hint}>
          <select aria-label={limit.label} value={settings.claudeWorkerLimit} onChange={(event) => void change({ key: "claudeWorkerLimit", value: Number(event.target.value) })}>
            {WORKER_LIMITS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Row>
        <Toggle label="Keep workers’ prompt cache for 1 hour" hint="Cheaper when a bot sends workers often; writing the longer cache costs a little more." checked={settings.subagentHourCache} onChange={(value) => void change({ key: "subagentHourCache", value })} />
        <Row label="Context window" hint={compact ? `Compacts at ${tokensLabel(compact)} tokens · from ~/.claude/settings.json (autoCompactWindow)` : "Claude Code’s own default · set autoCompactWindow in ~/.claude/settings.json to change it"}>
          {compact ? <span className="settings-tag" aria-label="Auto-compact window">{tokensLabel(compact)}</span> : null}
        </Row>
      </div>
    </>} />
  );
}

function CodexTable({ settings, change, discovery, codexModels }: { settings: SettingsView; change: Change; discovery: import("../contract/model-discovery").ModelDiscovery | null; codexModels: CodexModelOption[] }) {
  const defaults = settings.engineDefaults;
  const workers = settings.codexWorkers;
  const following = settings.codexWorkersFollow;
  const file = settings.codexConfigFile ?? null;
  const options = codexModels.map((model) => ({ id: model.id, label: `${model.name}${model.isDefault ? " (default)" : ""}` }));
  const fromFile = (value: string | null | undefined, none: string) => <div className="mw-readonly" aria-label="From config.toml">{value || none}</div>;
  return (
    <Table label="Codex"
      workersHead={<label className="mw-follow">Follow config.toml <input type="checkbox" role="switch" aria-label="Follow ~/.codex/config.toml" checked={following} onChange={(event) => void change({ key: "codexWorkersFollow", value: event.target.checked })} /></label>}
      rows={[
        { label: "Model",
          head: <><ModelSelect label="Codex head model" blank="Codex default" options={options} discovery={discovery} value={defaults.models.codex} onChange={(model) => void change({ key: "defaultEngineModel", value: { engine: "codex", model } })} />
            <Hint>The list comes from your installed Codex.</Hint></>,
          workers: following
            ? <>{fromFile(file?.model, "Codex default")}<Hint>{file ? "What ~/.codex/config.toml says, read-only." : "No ~/.codex/config.toml: Codex’s own default."}</Hint></>
            : <><SelectSetting label="Codex workers model" blank="Same as head" options={options} value={workers.model} onChange={(value) => void change({ key: "codexWorkers", value: { ...workers, model: value } })} />
              <Hint>Turn on Follow config.toml to use ~/.codex/config.toml instead.</Hint></> },
        { label: "Effort",
          head: <EffortControl label="Codex head effort" engine="codex" blank="Default" value={defaults.efforts.codex} onChange={(effort) => void change({ key: "defaultEffort", value: { engine: "codex", effort } })} />,
          workers: following
            ? fromFile(effortName(file?.effort), "Default")
            : <EffortControl label="Codex workers effort" engine="codex" blank="Same" value={workers.effort === "max" ? "xhigh" : workers.effort} onChange={(effort) => void change({ key: "codexWorkers", value: { ...workers, effort } })} /> },
        { label: "Speed",
          head: <span className="settings-hint">Standard</span>,
          workers: following
            ? fromFile(file?.fast === true ? "Fast" : file?.fast === false ? "Standard" : null, "Standard")
            : <label className="mw-inline-toggle"><span>Fast mode<span className="settings-hint">Faster replies, uses more of your limits</span></span>
                <input type="checkbox" role="switch" aria-label="Codex workers fast mode" checked={!!workers.fast} onChange={(event) => void change({ key: "codexWorkers", value: { ...workers, fast: event.target.checked } })} /></label> },
      ]} />
  );
}

function AgyTable({ client, settings, change, discovery, onNavigate }: { client: Client; settings: SettingsView; change: Change; discovery: import("../contract/model-discovery").ModelDiscovery | null; onNavigate: (section: SettingsSection) => void }) {
  const defaults = settings.engineDefaults;
  const [runtime, setRuntime] = useState<{ valid: boolean; message?: string } | null>(null);
  useEffect(() => {
    let live = true;
    void client.request({ type: "agy.runtime.check" }).then((value) => { if (live) setRuntime(value as { valid: boolean; message?: string }); }, () => { if (live) setRuntime({ valid: false }); });
    return () => { live = false; };
  }, [client]);
  return (
    <div className="mw-agy">
      <div className="mw-agy-status">
        <span className={runtime?.valid ? "mw-ok" : "mw-warn"} role="status">● {runtime === null ? "Checking runtime…" : runtime.valid ? "Runtime verified" : "Runtime not verified"} · <button type="button" className="settings-link" onClick={() => onNavigate("setup")}>Engine setup</button></span>
        <span className="settings-tag">Workers: Preview</span>
      </div>
      <Table label="Antigravity" rows={[
        { label: "Model",
          head: <ModelSelect label="Antigravity head model" blank="Antigravity default" discovery={discovery} value={defaults.models.agy} onChange={(model) => void change({ key: "defaultEngineModel", value: { engine: "agy", model } })} />,
          workers: <><ModelSelect label="Antigravity workers model" blank="Same as head" discovery={discovery} value={settings.agyWorkerModel} onChange={(value) => void change({ key: "agyWorkerModel", value })} />
            <Hint>The list comes from the Antigravity runtime.</Hint></> },
        { label: "Effort",
          head: <EffortControl label="Antigravity head effort" engine="agy" blank="Default" value={defaults.efforts.agy} onChange={(effort) => void change({ key: "defaultEffort", value: { engine: "agy", effort } })} />,
          workers: <EffortControl label="Antigravity workers effort" engine="agy" blank="Same" value={settings.agyWorkerEffort} onChange={(effort) => void change({ key: "agyWorkerEffort", value: effort })} /> },
      ]} />
      <p className="settings-note">Antigravity workers are in preview. Each starts on these; one left as “Same” uses the head’s model or effort.</p>
    </div>
  );
}

type OwnBot = { bot: BotView; view: BotSettingsView; words: string[] };

/** New bots: their engines and primary; then one folded line for the bots with their own settings, and Apply to all bots. */
function NewBots({ client, settings, change, bots, onOpenBot }: { client: Client; settings: SettingsView; change: Change; bots: BotView[]; onOpenBot?: (botId: string) => void }) {
  const defaults = settings.engineDefaults;
  const [views, setViews] = useState<Record<string, BotSettingsView>>({});
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = useMemo(() => bots.map((bot) => bot.id).join(), [bots]);
  const load = useCallback(() => {
    let live = true;
    void Promise.all(bots.map((bot) => client.request({ type: "bot.settings", botId: bot.id }).then((view) => [bot.id, view] as const, () => null)))
      .then((entries) => { if (live) setViews(Object.fromEntries(entries.filter((entry): entry is readonly [string, BotSettingsView] => !!entry && !!entry[1]))); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, ids]);
  useEffect(load, [load, settings]);
  const own: OwnBot[] = bots.flatMap((bot) => { const view = views[bot.id]; if (!view || !Array.isArray(view.engines)) return []; const words = ownChoices(view, settings); return words.length ? [{ bot, view, words }] : []; });
  const useDefaults = async (entry: OwnBot) => {
    setProblem(null);
    try { const view = await client.request({ type: "bot.configure", botId: entry.bot.id, ...defaultsChange(entry.view, settings) }); setViews((all) => ({ ...all, [entry.bot.id]: view })); }
    catch (failure) { setProblem(why(failure)); }
  };
  const toggle = (engine: EngineId, wanted: boolean) => {
    const next = wanted ? [...defaults.engines, engine] : defaults.engines.filter((candidate) => candidate !== engine);
    void change({ key: "defaultEngines", value: next as EngineId[] });
  };
  return (
    <Group title="New bots">
      <Row label="Engines" hint="A new bot starts with these.">
        <span className="mw-engine-checks">
          {(["claude", "codex", "agy"] as const).map((engine) => {
            const on = defaults.engines.includes(engine);
            return <label key={engine} className="mw-check"><input type="checkbox" aria-label={ENGINE_NAMES[engine]} checked={on} disabled={on && defaults.engines.length === 1} onChange={(event) => toggle(engine, event.target.checked)} /> {ENGINE_NAMES[engine]}</label>;
          })}
        </span>
      </Row>
      <Row label="Primary engine" hint="Who a message goes to unless you pick another in the composer. A bot can choose its own.">
        <SelectSetting label="Primary engine" blank="First engine of each bot" options={defaults.engines.map((engine) => ({ id: engine, label: ENGINE_NAMES[engine] }))} value={defaults.primary}
          onChange={(value) => void change({ key: "defaultPrimaryEngine", value: value as EngineId | null })} />
      </Row>
      <div className="mw-own">
        <button type="button" className="mw-own-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span>{own.length === 1 ? "1 bot uses its own settings" : `${own.length} bots use their own settings`}<span className="settings-hint">Change those in each bot’s panel. They are not shown here one by one.</span></span>
          <span className="settings-hint">{open ? "Hide ▴" : "Show ▾"}</span>
        </button>
        {open && <div className="mw-own-list">
          {own.map((entry) => (
            <div key={entry.bot.id} className="mw-own-row">
              <span><strong>{entry.bot.name}</strong> <span className="settings-hint mw-own-diff">· {entry.words.join(" · ")}</span></span>
              <span className="mw-own-actions">
                {onOpenBot && <button type="button" className="settings-link" onClick={() => onOpenBot(entry.bot.id)}>Open</button>}
                <button type="button" className="settings-link" onClick={() => void useDefaults(entry)}>Use defaults</button>
              </span>
            </div>
          ))}
          {!own.length && <p className="settings-hint">Every bot follows these defaults.</p>}
          <ApplyAll client={client} botCount={bots.length} onApplied={load} />
          {problem && <p className="settings-problem" role="alert">{problem}</p>}
        </div>}
      </div>
    </Group>
  );
}

/** "Apply to all bots": every bot's engines, models, effort and primary become the defaults, after a confirmation. */
function ApplyAll({ client, botCount, onApplied }: { client: Client; botCount: number; onApplied: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const apply = async () => {
    setApplying(true); setOutcome(null);
    try {
      const result = await client.request({ type: "engineDefaults.applyAll", confirmed: true });
      setOutcome(result.failed.length
        ? { ok: false, text: `Applied to ${result.applied} bots. Could not change: ${result.failed.map((failure) => `${failure.name} (${failure.reason})`).join("; ")}` }
        : { ok: true, text: `Applied to ${result.applied} bots.` });
      onApplied();
    } catch (failure) { setOutcome({ ok: false, text: why(failure) }); }
    finally { setApplying(false); setConfirming(false); }
  };
  return (
    <div className="mw-apply">
      {!confirming
        ? <button type="button" className="settings-link" disabled={applying} onClick={() => { setOutcome(null); setConfirming(true); }}>Apply to all bots…</button>
        : <span className="settings-confirm" role="alertdialog" aria-label="Confirm apply to all bots">
            <span>Overwrite the engines, models, effort and primary engine of {botCount ? `all ${botCount} bots` : "every bot"}? Their own choices are lost.</span>
            <button type="button" disabled={applying} onClick={() => void apply()}>{applying ? "Applying…" : "Overwrite all bots"}</button>
            <button type="button" disabled={applying} onClick={() => setConfirming(false)}>Cancel</button>
          </span>}
      {outcome && <p className={outcome.ok ? "settings-hint" : "settings-problem"} role={outcome.ok ? "status" : "alert"}>{outcome.text}</p>}
    </div>
  );
}
