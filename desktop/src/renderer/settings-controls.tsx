// The small controls Settings and a bot's settings panel are drawn with (one look: grouped cards of rows, a label
// with a hint on the left, the control on the right).
import React from "react";
import type { ModelDiscovery } from "../contract/model-discovery";
import { EFFORTS_BY_ENGINE } from "../contract/efforts";
import { CLAUDE_MODEL_ALIASES, CLAUDE_MODEL_HINT, isClaudeModel } from "../contract/claude-model";
import { RequestFailed } from "./client";
import type { EngineId } from "./bot-defaults";

export const why = (failure: unknown) => (failure instanceof RequestFailed ? failure.error.message : String((failure as Error)?.message ?? failure));

/** The quick picks for a Claude model: the family aliases (any full `claude-*` id is a custom entry, see `claudeCustom`). */
export const CLAUDE_MODELS: readonly { id: string; label: string }[] = CLAUDE_MODEL_ALIASES.map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }));
/** A "custom model" entry for a Claude model picker: any id `isClaudeModel` accepts, typed in. */
export const claudeCustom: CustomModelEntry = { check: isClaudeModel, placeholder: "claude-…", invalid: `Not a Claude model: ${CLAUDE_MODEL_HINT}.` };
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

/** What a picker needs to take a value typed in, beside its list: a check, a placeholder, and what to say about a value that fails. */
export interface CustomModelEntry { check: (value: string) => boolean; placeholder: string; invalid: string }
/** The option value of "Custom model…" in a picker's list (no real model id has underscores around it). */
export const CUSTOM_CHOICE = "__custom__";

/**
 * The text box of a "Custom model…" entry. Enter (not while an input method is composing) or leaving the box saves the
 * typed id when `custom.check` accepts it; Escape closes the box (and stops there: it must not also close Settings);
 * an id that fails is not saved and the reason shows. `initial` is the value being edited: typing it again changes nothing.
 */
export function CustomModelBox({ label, initial, custom, disabled, onSave, onCancel }: { label: string; initial: string; custom: CustomModelEntry; disabled?: boolean; onSave: (value: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = React.useState(initial);
  const [rejected, setRejected] = React.useState(false);
  const commit = () => {
    const id = draft.trim();
    if (!id || id === initial) { onCancel(); return; }
    if (!custom.check(id)) { setRejected(true); return; }
    onSave(id);
  };
  return (
    <>
      <input type="text" aria-label={`${label}: custom model id`} placeholder={custom.placeholder} value={draft} disabled={disabled} autoFocus spellCheck={false} aria-invalid={rejected}
        onChange={(event) => { setDraft(event.target.value); setRejected(false); }}
        onKeyDown={(event) => {
          if (event.key === "Enter") { if (!event.nativeEvent.isComposing) { event.preventDefault(); commit(); } }
          else if (event.key === "Escape") { event.stopPropagation(); onCancel(); }
        }}
        onBlur={() => { const id = draft.trim(); if (!id) return; if (custom.check(id)) commit(); else setRejected(true); }} />
      {rejected && <span className="settings-hint" role="alert">{custom.invalid}</span>}
    </>
  );
}

/**
 * A dropdown of choices; `blank` is the first option, for no choice (null). A saved value the list does not
 * have (an older setting, a model the CLI no longer lists, a custom id) stays as an extra option, so it is not lost.
 * With `custom`, a last option "Custom model…" opens a `CustomModelBox`.
 */
export function SelectSetting({ label, options, value, onChange, blank, disabled, custom }: { label: string; options: readonly { id: string; label: string }[]; value: string | null; onChange: (value: string | null) => void; blank?: string; disabled?: boolean; custom?: CustomModelEntry }) {
  const extra = value !== null && value !== "" && !options.some((option) => option.id === value);
  const [typing, setTyping] = React.useState(false);
  return (
    <>
      <select aria-label={label} value={typing ? CUSTOM_CHOICE : value ?? ""} disabled={disabled} onChange={(event) => {
        if (event.target.value === CUSTOM_CHOICE) { setTyping(true); return; }
        setTyping(false);
        onChange(event.target.value || null);
      }}>
        {blank !== undefined && <option value="">{blank}</option>}
        {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        {extra && <option value={value}>{value}</option>}
        {custom && <option value={CUSTOM_CHOICE}>Custom model…</option>}
      </select>
      {custom && typing && <CustomModelBox label={label} initial={value ?? ""} custom={custom} disabled={disabled} onSave={(id) => { setTyping(false); onChange(id); }} onCancel={() => setTyping(false)} />}
    </>
  );
}

/** A model dropdown: the fixed `options`, then what the engine reports (`discovery`, when asked), without repeats. */
export function ModelSelect({ label, options = [], discovery, value, onChange, blank, disabled, custom }: { label: string; options?: readonly { id: string; label: string }[]; discovery?: ModelDiscovery | null; value: string | null; onChange: (value: string | null) => void; blank: string; disabled?: boolean; custom?: CustomModelEntry }) {
  const reported = discovery?.status === "ready" ? discovery.models.map((model) => ({ id: model.id, label: `${model.name}${model.isDefault && !/default/i.test(model.name) ? " (default)" : ""}` })) : [];
  const all = [...options, ...reported.filter((model) => !options.some((option) => option.id === model.id))];
  return <SelectSetting label={label} blank={blank} options={all} value={value} onChange={onChange} disabled={disabled} custom={custom} />;
}
