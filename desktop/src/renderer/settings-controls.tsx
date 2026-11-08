// The small controls Settings and a bot's settings panel are drawn with (one look: grouped cards of rows, a label
// with a hint on the left, the control on the right).
import React from "react";
import type { ModelDiscovery } from "../contract/model-discovery";
import { EFFORTS_BY_ENGINE } from "../contract/efforts";
import { RequestFailed } from "./client";
import type { EngineId } from "./bot-defaults";

export const why = (failure: unknown) => (failure instanceof RequestFailed ? failure.error.message : String((failure as Error)?.message ?? failure));

export const CLAUDE_MODELS = [{ id: "haiku", label: "Haiku" }, { id: "sonnet", label: "Sonnet" }, { id: "opus", label: "Opus" }] as const;
export const EFFORTS = [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "xhigh", label: "Extra high" }, { id: "max", label: "Max" }] as const;
export type EffortId = (typeof EFFORTS)[number]["id"];
/** Only the levels the engine's own control takes (`EFFORTS_BY_ENGINE`). */
export const effortOptions = (engine: EngineId) => EFFORTS.filter((effort) => (EFFORTS_BY_ENGINE[engine] as readonly string[]).includes(effort.id));

export function Group({ title, children, note, action, className }: { title: string; children: React.ReactNode; note?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <section className={`settings-group${className ? ` ${className}` : ""}`} aria-label={title}>
      <div className="settings-group-head"><h3>{title}</h3>{action}</div>
      <div className="settings-card">{children}</div>
      {note && <p className="settings-note">{note}</p>}
    </section>
  );
}

export function Row({ label, children, hint, className }: { label: React.ReactNode; children?: React.ReactNode; hint?: React.ReactNode; className?: string }) {
  return (
    <div className={`settings-row${className ? ` ${className}` : ""}`}>
      <div className="settings-label">{label}{hint && <div className="settings-hint">{hint}</div>}</div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

export function Toggle({ label, checked, onChange, disabled, hint }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; hint?: React.ReactNode }) {
  return (
    <Row label={label} hint={hint}>
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    </Row>
  );
}

export function Segmented<T extends string>({ label, options, value, onChange, disabled, className }: { label: string; options: readonly { id: T; label: string }[]; value: T | null; onChange: (value: T) => void; disabled?: boolean; className?: string }) {
  return (
    <div className={`segmented${className ? ` ${className}` : ""}`} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" role="radio" aria-checked={value === option.id} disabled={disabled} className={value === option.id ? "on" : ""} onClick={() => onChange(option.id)}>{option.label}</button>
      ))}
    </div>
  );
}

/** An effort as a segmented control: `blank` first (null: the default, or the head's), then the engine's own levels. */
export function EffortControl({ label, engine, value, blank, onChange, disabled }: { label: string; engine: EngineId; value: string | null; blank: string; onChange: (value: EffortId | null) => void; disabled?: boolean }) {
  const options = [{ id: "", label: blank }, ...effortOptions(engine)];
  return <Segmented label={label} className="effort-segmented" options={options} value={value ?? ""} disabled={disabled} onChange={(id) => onChange((id || null) as EffortId | null)} />;
}

/**
 * A dropdown of choices; `blank` is the first option, for no choice (null). A saved value the list does not
 * have (an older setting, or a model the CLI no longer lists) stays as an extra option, so it is not lost.
 */
export function SelectSetting({ label, options, value, onChange, blank, disabled }: { label: string; options: readonly { id: string; label: string }[]; value: string | null; onChange: (value: string | null) => void; blank?: string; disabled?: boolean }) {
  const extra = value !== null && value !== "" && !options.some((option) => option.id === value);
  return (
    <select aria-label={label} value={value ?? ""} disabled={disabled} onChange={(event) => onChange(event.target.value || null)}>
      {blank !== undefined && <option value="">{blank}</option>}
      {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      {extra && <option value={value}>{value}</option>}
    </select>
  );
}

/** A model dropdown: the fixed `options`, then what the engine reports (`discovery`, when asked), without repeats. */
export function ModelSelect({ label, options = [], discovery, value, onChange, blank, disabled }: { label: string; options?: readonly { id: string; label: string }[]; discovery?: ModelDiscovery | null; value: string | null; onChange: (value: string | null) => void; blank: string; disabled?: boolean }) {
  const reported = discovery?.status === "ready" ? discovery.models.map((model) => ({ id: model.id, label: `${model.name}${model.isDefault && !/default/i.test(model.name) ? " (default)" : ""}` })) : [];
  const all = [...options, ...reported.filter((model) => !options.some((option) => option.id === model.id))];
  return <SelectSetting label={label} blank={blank} options={all} value={value} onChange={onChange} disabled={disabled} />;
}
