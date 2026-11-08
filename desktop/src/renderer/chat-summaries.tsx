// botling.catchup's settings (hidden on the Plugins page), drawn as they were when the core kept them: the summaries
// themselves on Settings → Chat & reports, their model on Settings → Models & workers (Special jobs). Nothing shows
// while that plugin is off.
import { useEffect, useState } from "react";
import type { PluginsView } from "../contract";
import type { Client } from "./client";
import { SummaryModelPicker, useModelDiscovery } from "./ModelPicker";
import { CLAUDE_MODELS, Group, Row, Toggle, why } from "./settings-controls";
import { ENGINE_NAMES, type EngineId } from "./bot-defaults";

/** The built-in plugin that writes chat summaries; its settings are set in Settings, not on the Plugins page. */
export const SUMMARIES = "botling.catchup";
export type CodexModelOption = { id: string; name: string; isDefault: boolean };

function useSummaries(client: Client, plugins: PluginsView | null, onProblem: (problem: string | null) => void) {
  const plugin = plugins?.plugins.find((candidate) => candidate.name === SUMMARIES && candidate.enabled && !candidate.failure);
  const setting = (key: string) => plugin?.settings.find((entry) => entry.key === `${SUMMARIES}.${key}`);
  const value = (key: string) => setting(key)?.value ?? setting(key)?.default ?? null;
  const set = (key: string, next: boolean | number | string | null) => {
    onProblem(null);
    void client.request({ type: "plugins.setting", name: SUMMARIES, key: `${SUMMARIES}.${key}`, value: next }).catch((failure) => onProblem(why(failure)));
  };
  return { plugin, setting, value, set };
}

/**
 * The model lists of every engine for the summary picker. With a bot to ask, the engines report their own (as the
 * pickers elsewhere do); without one, Codex's own list and Claude's three aliases stand in, and Antigravity has none.
 */
function useSummaryDiscovery(client: Client, botId: string | null, codexModels: CodexModelOption[], wanted: boolean) {
  const asked = {
    claude: useModelDiscovery(client, botId ?? "", "claude", !!botId && wanted),
    codex: useModelDiscovery(client, botId ?? "", "codex", !!botId && wanted),
    agy: useModelDiscovery(client, botId ?? "", "agy", !!botId && wanted),
  };
  if (botId) return asked;
  const ready = (models: { id: string; name: string; isDefault: boolean }[], source: string) => ({ status: "ready" as const, source, message: "", models: models.map((model) => ({ ...model, efforts: null })) });
  return {
    claude: { ...asked.claude, result: ready(CLAUDE_MODELS.map((model) => ({ id: model.id, name: model.label, isDefault: false })), "Claude Code") },
    codex: { ...asked.codex, result: ready(codexModels, "Codex") },
    agy: asked.agy,
  };
}

/** Models & workers → Special jobs → Chat summaries: which engine and model write them. */
export function SummaryModelRow({ client, plugins, codexModels, modelBotId, onProblem, onOptions }: { client: Client; plugins: PluginsView | null; codexModels: CodexModelOption[]; modelBotId: string | null; onProblem: (problem: string | null) => void; onOptions: () => void }) {
  const { plugin, setting, value, set } = useSummaries(client, plugins, onProblem);
  const discovery = useSummaryDiscovery(client, modelBotId, codexModels, !!plugin);
  if (!plugin) return null;
  const model = typeof value("model") === "string" && (value("model") as string).trim() ? (value("model") as string).trim() : null;
  const engine = model && (value("engine") === "claude" || value("engine") === "agy") ? value("engine") as EngineId : "codex";
  const chosen = { engine, model: model ?? String(setting("model")?.default ?? "") };
  return (
    <Row label="Chat summaries" hint={<>Writes catch-up summaries with {ENGINE_NAMES[chosen.engine]} · {chosen.model}. Claude or Codex; Antigravity can’t. <button type="button" className="settings-link" onClick={onOptions}>Summary options</button></>}>
      <SummaryModelPicker label="Summary model" value={chosen} discovery={discovery} unavailable={["agy"]}
        unavailableNote="Antigravity models can't write summaries: it has no read-only one-shot mode."
        onChange={(next) => { const id = next?.model.trim(); set("model", id || null); set("engine", id ? next!.engine : null); }} />
    </Row>
  );
}

/** Chat & reports → Chat summaries: when they are written, the thresholds and the prompt. */
export function ChatSummaries({ client, plugins, onProblem, onModel }: { client: Client; plugins: PluginsView | null; onProblem: (problem: string | null) => void; onModel: () => void }) {
  const { plugin, setting, value, set } = useSummaries(client, plugins, onProblem);
  const defaultPrompt = typeof setting("prompt")?.default === "string" ? setting("prompt")!.default as string : "";
  const saved = typeof value("prompt") === "string" && value("prompt") !== defaultPrompt ? value("prompt") as string : null;
  const [prompt, setPrompt] = useState(saved ?? defaultPrompt);
  useEffect(() => setPrompt(saved ?? defaultPrompt), [saved, defaultPrompt]);
  if (!plugin) return <Group title="Chat summaries" note="Turn on the Chat summaries plugin (Plugins) to set them here."><Row label="Chat summaries" hint="The plugin is off." /></Group>;
  const threshold = (key: string) => (typeof value(key) === "number" ? Math.min(50, Math.max(1, Math.round(value(key) as number))) : 3);
  return (
    <Group title="Chat summaries" note={<>The model that writes them is in <button type="button" className="settings-link" onClick={onModel}>Models &amp; workers</button>.</>}>
      <Toggle label="Summarize unread messages" checked={value("unread") !== false} onChange={(next) => set("unread", next)} />
      <Toggle label="Summarize between your messages" checked={value("interval") === true} onChange={(next) => set("interval", next)} />
      {value("customThresholds") === true ? (
        <>
          <Row label="Unread threshold"><input type="number" aria-label="Unread threshold" min={1} max={50} value={threshold("unreadThreshold")} onChange={(event) => { const next = Number(event.target.value); if (next >= 1 && next <= 50) set("unreadThreshold", Math.round(next)); }} /></Row>
          <Row label="Interval threshold"><input type="number" aria-label="Interval threshold" min={1} max={50} value={threshold("intervalThreshold")} onChange={(event) => { const next = Number(event.target.value); if (next >= 1 && next <= 50) set("intervalThreshold", Math.round(next)); }} /></Row>
          <div className="settings-actions"><button type="button" onClick={() => { set("customThresholds", false); set("unreadThreshold", null); set("intervalThreshold", null); }}>Use default thresholds</button></div>
        </>
      ) : (
        <Row label="Default thresholds: unread > 3, interval ≥ 3 bot replies">
          <button type="button" onClick={() => set("customThresholds", true)}>Adjust individually</button>
        </Row>
      )}
      <div className="settings-prompt">
        <div className="settings-label">Summary prompt <span className="settings-tag">{saved ? "Custom" : "Default"}</span></div>
        <textarea aria-label="Summary prompt" rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)}
          onBlur={() => { const next = prompt.trim() && prompt !== defaultPrompt ? prompt : null; if (next !== saved) set("prompt", next); }} />
        <div className="settings-actions"><button type="button" disabled={!saved} onClick={() => set("prompt", null)}>Restore default prompt</button></div>
      </div>
    </Group>
  );
}
