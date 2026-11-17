import { useEffect, useRef, useState } from 'react';
import type { ModelDiscovery, ModelEngine } from '../contract/model-discovery';
import type { Client } from './client';
import { CUSTOM_CHOICE, CustomModelBox, type CustomModelEntry } from './settings-controls';

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
/** `custom`: a last option "Custom model…" for an id the engine's list does not have (Claude: any `claude-*`). */
export function ModelPicker({ label, value, blank = 'Engine default', discovery, onChange, subagents = false, custom }: {
  label: string; value: string | null; blank?: string;
  discovery: ReturnType<typeof useModelDiscovery>;
  onChange: (value: string | null) => void; subagents?: boolean; custom?: CustomModelEntry;
}) {
  const [typing, setTyping] = useState(false);
  const { result, loading, refresh } = discovery;
  const models = result?.status === 'ready' ? result.models : [];
  const selected = models.find(model => model.id === value);
  const missing = value !== null && !selected;
  return <div className="model-picker">
    <div className="model-picker-controls">
      <select title={value ?? "Use the account / engine default"} aria-label={label} value={typing ? CUSTOM_CHOICE : value ?? ''} onChange={event => { if (event.target.value === CUSTOM_CHOICE) { setTyping(true); return; } setTyping(false); onChange(event.target.value || null); }}>
        <button type="button" tabIndex={-1}><span className="model-selected-text">{typing ? 'Custom model…' : value === null ? blank : selected?.name ?? `${value} (saved)`}</span></button>
        <option value="">{blank}</option>
        {missing && <option value={value!}>{value} (saved)</option>}
        {models.length > 0 && <optgroup label="Reported by engine">
          {models.map(model => <option key={model.id} value={model.id}>{model.name}{model.isDefault && !/default/i.test(model.name) ? ' (default)' : ''}</option>)}
        </optgroup>}
        {custom && <option value={CUSTOM_CHOICE}>Custom model…</option>}
      </select>
      <button type="button" disabled={loading} aria-label={`Refresh ${label}`} onClick={refresh}>{loading ? 'Loading' : result?.status === 'ready' ? 'Refresh' : 'Retry'}</button>
    </div>
    <p className="settings-note" role="status">
      {loading ? 'Loading models from the engine…' : result ? <>{result.status === 'ready' ? `${models.length ? 'From ' + (result.source.startsWith('Claude') ? 'Claude Code' : result.source.startsWith('Codex') ? 'Codex' : 'Antigravity ACP') : 'No models returned'} · access checked when used.` : result.message}</> : 'Models have not been loaded.'}
    </p>
    {custom && typing && <div className="model-picker-controls"><CustomModelBox label={label} initial={value ?? ''} custom={custom} onSave={id => { setTyping(false); onChange(id); }} onCancel={() => setTyping(false)} /></div>}
    {missing && !loading && <p className="settings-note">Saved ID is not in the current list; kept unchanged.</p>}
    {subagents && <p className="settings-note">Uses Claude’s catalog; whether workers can use a model is not reported separately.</p>}
  </div>;
}
