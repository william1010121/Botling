// The shown bot's own choices, in the right panel one level in (1.x's SettingsPage in DetailPanel). Each row shows the
// value in use and whether it follows the app's default ("App default") or is this bot's own ("Own · app default: …",
// marked); each engine has "Use app defaults". Changing the app's defaults is Settings → Models & workers.
import React, { useEffect, useState } from "react";
import type { BotSettingsView, BotView, SettingsView } from "../contract";
import type { Client } from "./client";
import { ModelPicker, useModelDiscovery } from "./ModelPicker";
import { Group, Row, SelectSetting, Toggle, effortOptions, why } from "./settings-controls";
import { choiceLabel, defaultsChange, sameAsHead, engineChoices, ENGINE_NAMES, FIELD_LABELS, type ChoiceRow, type ConfigureChange, type EngineId } from "./bot-defaults";

export function BotSettings({ client, bot, settings = null, onOpenAppSettings }: { client: Client; bot: BotView; settings?: SettingsView | null; onOpenAppSettings?: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      {problem && <p className="settings-problem" role="alert">{problem}</p>}
      <ThisBot key={bot.id} client={client} bot={bot} appSettings={settings} onProblem={setProblem} onOpenAppSettings={onOpenAppSettings} />
    </>
  );
}

function ThisBot({ client, bot, appSettings, onProblem, onOpenAppSettings }: { client: Client; bot: BotView; appSettings: SettingsView | null; onProblem: (problem: string | null) => void; onOpenAppSettings?: () => void }) {
  const [view, setView] = useState<BotSettingsView | null>(null);
  const [fetched, setFetched] = useState<SettingsView | null>(null);
  // The app's defaults, to compare with (asked for when the caller has none; a reply without them compares nothing).
  const settings = appSettings ?? (fetched?.engineDefaults ? fetched : null);
  const engines = view?.engines ?? bot.heads;
  const discovery = {
    claude: useModelDiscovery(client, bot.id, "claude", engines.includes("claude")),
    codex: useModelDiscovery(client, bot.id, "codex", engines.includes("codex")),
    agy: useModelDiscovery(client, bot.id, "agy", engines.includes("agy")),
  };
  useEffect(() => { void client.request({ type: "bot.settings", botId: bot.id }).then(setView, (failure) => onProblem(why(failure))); }, [client, bot.id, bot.heads.length, onProblem]);
  useEffect(() => { if (!appSettings) void client.request({ type: "settings.get" }).then(setFetched, () => {}); }, [client, appSettings]);
  const configure = (change: ConfigureChange) => {
    onProblem(null);
    void client.request({ type: "bot.configure", botId: bot.id, ...change }).then(setView, (failure) => onProblem(why(failure)));
  };
  const setHeads = (next: EngineId[]) => {
    onProblem(null);
    void client.request({ type: "heads.set", botId: bot.id, engines: next }).then(() => client.request({ type: "bot.settings", botId: bot.id })).then(setView, (failure) => onProblem(why(failure)));
  };
  if (!view) return null;
  const two = view.engines.length > 1;
  const workers = view.codexWorkers ?? { model: null, effort: null, fast: null };
  /** The control of one row: what it shows and the change it makes. */
  const control = (row: ChoiceRow): React.ReactNode => {
    const name = ENGINE_NAMES[row.engine];
    const label = `${name} ${FIELD_LABELS[row.field].replace("’", "'").toLowerCase()}`;
    const value = typeof row.value === "string" ? row.value : null;
    const effort = (blank: string, onChange: (level: BotSettingsView["effort"]) => void) =>
      <SelectSetting label={label} blank={blank} options={effortOptions(row.engine)} value={value} onChange={(level) => onChange(level as BotSettingsView["effort"])} />;
    // What "Same as head" is in this bot: its head's model (by the engine's own name for it) or effort.
    const modelName = (id: string) => { const found = discovery[row.engine].result; return found?.status === "ready" ? found.models.find((m) => m.id === id)?.name : null; };
    const head = (field: "workerModel" | "workerEffort") => sameAsHead(view, row.engine, field, modelName);
    switch (`${row.engine}.${row.field}`) {
      // Models: what the engine reports, with its loading state, Refresh and a saved ID kept when the list lacks it.
      case "claude.model": return <ModelPicker label={label} blank="Claude default" discovery={discovery.claude} value={value} onChange={(model) => configure({ model })} />;
      case "claude.workerModel": return <ModelPicker label={label} blank={head("workerModel")} discovery={discovery.claude} value={value} subagents onChange={(subagentModel) => configure({ subagentModel })} />;
      case "claude.workerEffort": return effort(head("workerEffort"), (subagentEffort) => configure({ subagentEffort }));
      case "codex.model": return <ModelPicker label={label} blank="Codex default" discovery={discovery.codex} value={value} onChange={(codexModel) => configure({ codexModel })} />;
      case "codex.workerModel": return <ModelPicker label={label} blank={head("workerModel")} discovery={discovery.codex} value={value} onChange={(model) => configure({ codexWorkers: { ...workers, model } })} />;
      case "codex.workerEffort": return effort(head("workerEffort"), (level) => configure({ codexWorkers: { ...workers, effort: level ?? null } }));
      case "codex.workerFast": return <SelectSetting label={label} blank="Same as head" options={[{ id: "fast", label: "Fast" }, { id: "standard", label: "Standard" }]} value={row.value === true ? "fast" : row.value === false ? "standard" : null}
        onChange={(choice) => configure({ codexWorkers: { ...workers, fast: choice === null ? null : choice === "fast" } })} />;
      case "agy.model": return <ModelPicker label={label} blank="Antigravity default" discovery={discovery.agy} value={value} onChange={(agyModel) => configure({ agyModel })} />;
      case "agy.workerModel": return <ModelPicker label={label} blank={head("workerModel")} discovery={discovery.agy} value={value} onChange={(agyWorkerModel) => configure({ agyWorkerModel })} />;
      case "agy.workerEffort": return effort(head("workerEffort"), (agyWorkerEffort) => configure({ agyWorkerEffort }));
      default: return effort("Default", (level) => configure({ efforts: { [row.engine]: level } }));
    }
  };
  return (
    <>
      <Group title="Engines in this bot" note="Choose a primary recipient in the composer. Enabled engines can collaborate when needed. Antigravity requires the verified official ACP runtime and Google sign-in.">
        {(["claude", "codex", "agy"] as const).map((engine) => {
          const on = view.engines.includes(engine);
          // 1.x's "Engines in this bot": the only head cannot go; turning off the first of two runs the bot on the other, through a handoff.
          return <Toggle key={engine} label={ENGINE_NAMES[engine]} checked={on} disabled={bot.phase === "switching" || (on && !two)}
            onChange={(wanted) => setHeads(wanted ? [...view.engines, engine] : view.engines.filter((candidate) => candidate !== engine))} />;
        })}
      </Group>
      {two && (
        <Group title="Primary engine" note="Who a message goes to unless you pick another in the composer.">
          <Row label="Primary engine" className={view.primary ? "own" : undefined} hint={view.primary ? `Own · app default: ${ENGINE_NAMES[settings?.engineDefaults.primary ?? view.engines[0]!]}` : "App default"}>
            <SelectSetting label="Primary engine" blank={`Follow app default (${ENGINE_NAMES[view.primaryEffective ?? view.engines[0]!]})`} options={view.engines.map((engine) => ({ id: engine, label: ENGINE_NAMES[engine] }))} value={view.primary ?? null}
              onChange={(value) => configure({ primary: value as BotSettingsView["engines"][number] | null })} />
          </Row>
        </Group>
      )}
      {view.engines.map((engine) => {
        const rows = engineChoices(view, settings, engine);
        const own = rows.some((row) => row.own);
        return (
          <Group key={engine} title={ENGINE_NAMES[engine]} className="bot-engine"
            action={<>
              {engine === "agy" && <span className="settings-tag">Workers: Preview</span>}
              {settings && <span className="settings-group-action">{own
                ? <button type="button" className="settings-link" aria-label={`${ENGINE_NAMES[engine]}: use app defaults`} onClick={() => configure(defaultsChange(view, settings!, engine))}>Use app defaults</button>
                : <span className="settings-hint">Follows app defaults</span>}</span>}
            </>}
            note={engine === "agy" ? "ACP uses single-action approval cards and app-managed tools. Native agents, workflows and global plugins are disabled." : engine === "codex" ? "Workers’ choices are used from the Codex head’s next wake." : undefined}>
            {rows.map((row) => (
              <Row key={row.field} label={FIELD_LABELS[row.field]} className={row.own ? "own" : undefined}
                hint={!settings ? undefined : row.own ? `Own · app default: ${choiceLabel(engine, row.field, row.appDefault)}` : "App default"}>
                {control(row)}
              </Row>
            ))}
          </Group>
        );
      })}
      {onOpenAppSettings && <p className="settings-note"><button type="button" className="settings-link" onClick={onOpenAppSettings}>Change app defaults in Settings → Models &amp; workers</button></p>}
    </>
  );
}
