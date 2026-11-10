// The browser pane's site-tools sheet (design v4, "V2 toolbar + side sheet"): the tools for the active tab's site
// (browser-site-tools.ts), each with its Run button and form, or its switch; the last run's progress or result; and
// a button that asks the bot to make a tool for this site. Main runs the tools (browser-host.ts).
import { useEffect, useState, type ReactNode } from "react";
import { fieldDefault, siteOf, toolIsOn, toolsFor, type SiteToolOptions, type SiteToolView } from "../browser-site-tools";
import type { BrowserTabInfo, BrowserToolCatalog, BrowserToolRun } from "../browser-wire";
import { postBrowser, runKey } from "./browser-state";

/** The tools on the page's site the puzzle button counts: every one there except those turned off for it. */
export function countedTools(catalog: BrowserToolCatalog | null, url: string | undefined): number {
  const site = url ? siteOf(url) : null;
  if (!catalog || !url || !site) return 0;
  return toolsFor(catalog.tools, url).filter((tool) => tool.kind === "toggle" || toolIsOn(catalog.state, tool, site)).length;
}

function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange(on: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} disabled={disabled}
      className={`bp-switch${on ? " on" : ""}`} onClick={() => onChange(!on)}><span aria-hidden="true" /></button>
  );
}

function RunLine({ run }: { run: BrowserToolRun | undefined }) {
  if (!run) return null;
  if (run.status === "running") return <span className="bp-tool-status" role="status"><span className="bp-tab-spinner" aria-hidden="true" />{run.text ?? "Running…"}</span>;
  return <span className={`bp-tool-status${run.status === "failed" ? " failed" : ""}`} role="status" title={run.saved?.join("\n")}>{run.text}</span>;
}

function Field({ field, value, onChange }: { field: SiteToolView["fields"][number]; value: string | boolean; onChange(value: string | boolean): void }) {
  if (field.type === "choice") {
    return (
      <div className="bp-field">
        <span className="bp-field-label">{field.label}</span>
        <div className="bp-segments" role="group" aria-label={field.label}>
          {field.options.map((option) => (
            <button key={option} type="button" aria-pressed={value === option} className={value === option ? "on" : ""} onClick={() => onChange(option)}>{option}</button>
          ))}
        </div>
      </div>
    );
  }
  if (field.type === "check") {
    return (
      <label className="bp-field bp-field-check">
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        <span>{field.label}</span>
      </label>
    );
  }
  return (
    <label className="bp-field">
      <span className="bp-field-label">{field.label}</span>
      <input type="text" className="bp-field-text" value={String(value)} placeholder={field.placeholder} spellCheck={false} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export interface SiteToolsSheetProps {
  botId: string;
  botName: string;
  tab: BrowserTabInfo | null;
  catalog: BrowserToolCatalog | null;
  runs: Readonly<Record<string, BrowserToolRun>>;
  onClose(): void;
  /** Sends a message to the bot's chat; resolves once sent. */
  onAsk(text: string): Promise<void>;
  askText(url: string): string;
  closeIcon: ReactNode;
}

export function SiteToolsSheet({ botId, botName, tab, catalog, runs, onClose, onAsk, askText, closeIcon }: SiteToolsSheetProps) {
  const url = tab?.url ?? "";
  const site = siteOf(url);
  const host = site ?? url;
  const tools = catalog && site ? toolsFor(catalog.tools, url) : [];
  const [forms, setForms] = useState<Record<string, SiteToolOptions>>({});
  const [asked, setAsked] = useState<"no" | "sending" | "sent" | "failed">("no");
  useEffect(() => { setAsked("no"); }, [url, botId]);

  const valueOf = (tool: SiteToolView, field: SiteToolView["fields"][number]) => forms[tool.id]?.[field.id] ?? fieldDefault(field);
  const setValue = (tool: SiteToolView, id: string, value: string | boolean) => setForms((all) => ({ ...all, [tool.id]: { ...all[tool.id], [id]: value } }));
  const run = (tool: SiteToolView) => {
    if (!tab) return;
    const options: SiteToolOptions = {};
    for (const field of tool.fields) options[field.id] = valueOf(tool, field);
    postBrowser({ type: "tool.run", botId, tabId: tab.id, toolId: tool.id, ...(tool.fields.length ? { options } : {}) });
  };
  const set = (tool: SiteToolView, on: boolean) => { if (tab) postBrowser({ type: "tool.set", botId, tabId: tab.id, toolId: tool.id, on }); };
  const ask = () => {
    if (!url || asked === "sending") return;
    setAsked("sending");
    onAsk(askText(url)).then(() => setAsked("sent"), () => setAsked("failed"));
  };

  return (
    <aside className="bp-sheet" aria-label={`Site tools for ${host}`}>
      <div className="bp-sheet-head">
        <span>Tools for {host}</span>
        <button type="button" aria-label="Close site tools" onClick={onClose}>{closeIcon}</button>
      </div>
      <div className="bp-tools">
        {tools.length === 0 && <p className="bp-sheet-empty">No tools for this site yet.</p>}
        {tools.map((tool) => {
          const on = !!site && !!catalog && toolIsOn(catalog.state, tool, site);
          const last = tab ? runs[runKey(tab.id, tool.id)] : undefined;
          const busy = last?.status === "running";
          if (tool.kind === "toggle") {
            return (
              <div key={tool.id} className="bp-tool bp-tool-toggle">
                <div className="bp-tool-row">
                  <span className="bp-tool-name" title={tool.description || undefined}>{tool.name}</span>
                  <Switch on={on} label={`${tool.name} on ${host}`} disabled={busy} onChange={(next) => set(tool, next)} />
                </div>
                {last?.status === "failed" && <RunLine run={last} />}
              </div>
            );
          }
          return (
            <div key={tool.id} className={`bp-tool${on ? "" : " off"}`}>
              <div className="bp-tool-row">
                <span className="bp-tool-name">{tool.name}</span>
                <Switch on={on} label={`Use ${tool.name} on ${host}`} onChange={(next) => set(tool, next)} />
              </div>
              {on && (
                <>
                  {tool.description && <span className="bp-tool-about">{tool.description}</span>}
                  {tool.fields.map((field) => <Field key={field.id} field={field} value={valueOf(tool, field)} onChange={(value) => setValue(tool, field.id, value)} />)}
                  <button type="button" className="bp-tool-run" disabled={busy || !tab} onClick={() => run(tool)}>{busy ? "Running…" : tool.runLabel}</button>
                  <RunLine run={last} />
                </>
              )}
            </div>
          );
        })}
        {catalog && catalog.problems.length > 0 && (
          <div className="bp-tool-problems">
            <span>Tools that did not load</span>
            {catalog.problems.map((problem) => <span key={problem.id} title={problem.error}><b>{problem.id}</b>: {problem.error}</span>)}
          </div>
        )}
      </div>
      <button type="button" className="bp-tool-ask" disabled={!url || asked === "sending"} onClick={ask}>
        {asked === "sent" ? `Asked ${botName} ✓` : asked === "failed" ? "Could not send. Try again" : `Ask ${botName} to make a tool for this site`}
      </button>
    </aside>
  );
}
