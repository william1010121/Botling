import { useEffect, useRef, useState } from 'react';
import type { ModelDiscovery, ModelEngine } from '../contract/model-discovery';
import type { Client } from './client';

export function useModelDiscovery(client: Client, botId: string, engine: ModelEngine, enabled: boolean) {
  const [result, setResult] = useState<ModelDiscovery | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const epoch = ++generation.current;
    setResult(null);
    if (!enabled) { setLoading(false); return; }
    setLoading(true);
    void client.request({ type: 'engine.models', engine, botId }).then(
      value => { if (generation.current === epoch) setResult(value); },
      () => { if (generation.current === epoch) setResult({ status: 'error', models: [], source: '', message: 'Could not load models. Retry.' }); },
    ).finally(() => { if (generation.current === epoch) setLoading(false); });
    return () => { ++generation.current; };
  }, [client, botId, engine, enabled, revision]);
  return { result, loading, refresh: () => setRevision(value => value + 1) };
}
export function ModelPicker({ label, value, blank = 'Engine default', discovery, onChange, subagents = false }: {
  label: string; value: string | null; blank?: string;
  discovery: ReturnType<typeof useModelDiscovery>;
  onChange: (value: string | null) => void; subagents?: boolean;
}) {
  const { result, loading, refresh } = discovery;
  const models = result?.status === 'ready' ? result.models : [];
  const selected = models.find(model => model.id === value);
  const missing = value !== null && !selected;
  return <div className="model-picker">
    <div className="model-picker-controls">
      <select title={value ?? "Use the account / engine default"} aria-label={label} value={value ?? ''} onChange={event => onChange(event.target.value || null)}>
        <button type="button" tabIndex={-1}><span className="model-selected-text">{value === null ? blank : selected?.name ?? `${value} (saved)`}</span></button>
        <option value="">{blank}</option>
        {missing && <option value={value!}>{value} (saved)</option>}
        {models.length > 0 && <optgroup label="Reported by engine">
          {models.map(model => <option key={model.id} value={model.id}>{model.name}{model.isDefault && !/default/i.test(model.name) ? ' (default)' : ''}</option>)}
        </optgroup>}
      </select>
      <button type="button" disabled={loading} aria-label={`Refresh ${label}`} onClick={refresh}>{loading ? 'Loading' : result?.status === 'ready' ? 'Refresh' : 'Retry'}</button>
    </div>
    <p className="settings-note" role="status">
      {loading ? 'Loading models from the engine…' : result ? <>{result.status === 'ready' ? `${models.length ? 'From ' + (result.source.startsWith('Claude') ? 'Claude Code' : result.source.startsWith('Codex') ? 'Codex' : 'Antigravity ACP') : 'No models returned'} · access checked when used.` : result.message}</> : 'Models have not been loaded.'}
    </p>
    {missing && !loading && <p className="settings-note">Saved ID is not in the current list; kept unchanged.</p>}
    {subagents && <p className="settings-note">Uses Claude’s catalog; separate subagent availability is not reported.</p>}
  </div>;
}

export type SummaryChoice = { engine: ModelEngine; model: string };
const SUMMARY_ENGINES: { engine: ModelEngine; name: string; source: string }[] = [
  { engine: 'claude', name: 'Claude', source: 'Claude Code' }, { engine: 'codex', name: 'Codex', source: 'Codex' }, { engine: 'agy', name: 'Antigravity', source: 'Antigravity ACP' },
];
const choiceKey = (engine: ModelEngine, model: string) => `${engine}:${model}`;

/**
 * The Catch-up summary model: the same lists as `ModelPicker`, grouped by engine, one select. Engines that cannot
 * write a summary (`unavailable`) are listed but disabled, with `unavailableNote` under the picker.
 */
export function SummaryModelPicker({ label, value, discovery, unavailable = [], unavailableNote, onChange }: {
  label: string; value: SummaryChoice;
  discovery: Record<ModelEngine, ReturnType<typeof useModelDiscovery>>;
  unavailable?: ModelEngine[]; unavailableNote?: string;
  onChange: (value: SummaryChoice) => void;
}) {
  const loading = Object.values(discovery).some(one => one.loading);
  const lists = SUMMARY_ENGINES.map(item => ({ ...item, models: discovery[item.engine].result?.status === 'ready' ? discovery[item.engine].result!.models : [] }));
  const selected = lists.find(item => item.engine === value.engine)?.models.find(model => model.id === value.model);
  const missing = !selected;
  const key = choiceKey(value.engine, value.model);
  const messages = lists.map(item => ({ item, result: discovery[item.engine].result })).filter(({ result }) => result && result.status !== 'ready');
  return <div className="model-picker">
    <div className="model-picker-controls">
      <select title={`${value.engine}: ${value.model}`} aria-label={label} value={key} onChange={event => {
        const at = event.target.value.indexOf(':');
        onChange({ engine: event.target.value.slice(0, at) as ModelEngine, model: event.target.value.slice(at + 1) });
      }}>
        <button type="button" tabIndex={-1}><span className="model-selected-text">{selected?.name ?? `${value.model} (saved)`}</span></button>
        {missing && <option value={key}>{value.model} (saved)</option>}
        {lists.map(item => item.models.length > 0 && <optgroup key={item.engine} label={unavailable.includes(item.engine) ? `${item.name} (not available for summaries)` : item.name}>
          {item.models.map(model => <option key={model.id} value={choiceKey(item.engine, model.id)} disabled={unavailable.includes(item.engine)}>{model.name}{model.isDefault && !/default/i.test(model.name) ? ' (default)' : ''}</option>)}
        </optgroup>)}
      </select>
      <button type="button" disabled={loading} aria-label={`Refresh ${label}`} onClick={() => Object.values(discovery).forEach(one => one.refresh())}>{loading ? 'Loading' : 'Refresh'}</button>
    </div>
    <p className="settings-note" role="status">
      {loading ? 'Loading models from the engines…' : `From ${lists.filter(item => item.models.length).map(item => item.source).join(', ') || 'no engine'} · access checked when used.`}
    </p>
    {!loading && messages.map(({ item, result }) => <p key={item.engine} className="settings-note">{item.name}: {result!.message}</p>)}
    {unavailable.length > 0 && unavailableNote && <p className="settings-note">{unavailableNote}</p>}
  </div>;
}
