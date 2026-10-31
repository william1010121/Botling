// The Worktrees control in a project's right panel (core/worktrees.ts, docs/worktrees.md): its active
// worktrees with branch, changes and unmerged commits, and New worktree / Work here / Open in terminal /
// Merge into base / Discard. The core does the git; this shows what it says. Discarding work that would be
// lost asks first, in place. Hidden when the project is not a git repository or the setting is off.
import { useCallback, useEffect, useState } from "react";
import type { BotView, WorktreeAction, WorktreesView } from "../contract";
import { Client, RequestFailed } from "./client";
import { worktreeLine, worktreeWords } from "./worktree-text";
import { reviewWords } from "./review-text";
import type { ReviewTarget } from "./Review";

const POLL_MS = 10_000;

export function Worktrees({ client, bot, lang, onReview }: { client: Client; bot: BotView; lang: string | null; onReview?: (target: ReviewTarget) => void }) {
  const words = worktreeWords(lang);
  const look = reviewWords(lang);
  const [view, setView] = useState<WorktreesView | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => client.request({ type: "worktrees.list", botId: bot.id }).then(setView, () => setView(null)), [client, bot.id]);
  useEffect(() => {
    setView(null); setOpen(null); setNaming(null); setAsking(null); setNote(null);
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (request: Promise<WorktreeAction>) => {
    setBusy(true);
    try {
      const result = await request;
      setNote({ ok: result.ok, text: result.message });
      return result;
    } catch (failure) {
      const text = failure instanceof RequestFailed ? failure.error.message : String((failure as Error).message ?? failure);
      setNote({ ok: false, text });
      return null;
    } finally { setBusy(false); await refresh(); }
  };

  if (!view || !view.enabled || !view.available) return null;
  const submit = async () => {
    const name = (naming ?? "").trim();
    if (!name) return;
    const result = await act(client.request({ type: "worktrees.create", botId: bot.id, name }));
    if (result?.ok) setNaming(null);
  };

  return (
    <section className="detail-section worktrees-section" aria-label={words.title}>
      <div className="worktrees-head">
        <h3>{words.title}</h3>
        <span className="worktree-buttons">
          {onReview && <button type="button" className="task-report" onClick={() => onReview({ worktreeId: null, branch: null, base: null, path: null })}>{look.reviewMain}</button>}
          {naming === null && <button type="button" className="task-report" disabled={busy} onClick={() => { setNaming(""); setNote(null); }}>{words.add}</button>}
        </span>
      </div>
      {naming !== null && (
        <form className="worktree-new" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <input className="worktree-input" autoFocus value={naming} maxLength={80} placeholder={words.namePlaceholder} aria-label={words.namePlaceholder} onChange={(event) => setNaming(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setNaming(null); }} />
          <button type="submit" className="task-report" disabled={busy || !naming.trim()}>{words.create}</button>
          <button type="button" className="task-report" onClick={() => setNaming(null)}>{words.cancel}</button>
        </form>
      )}
      {view.items.filter((item) => item.status === "active").length === 0 && naming === null && <div className="task-none">{words.none}</div>}
      <div className="task-list">
        {view.items.filter((item) => item.status === "active").map((item) => {
          const expanded = open === item.id;
          const using = view.current === item.id;
          return (
            <div key={item.id} className="worktree" data-worktree={item.branch}>
              <div className="task-row" data-state={item.missing ? "stale" : using ? "running" : "idle"}>
                <span className="task-dot" data-state={item.missing ? "stale" : using ? "running" : "idle"} aria-hidden="true" />
                <button type="button" className="task-row-open" aria-expanded={expanded} title={item.path} onClick={() => { setOpen(expanded ? null : item.id); setAsking(null); }}>
                  <span className="task-row-name">{item.branch}</span>
                  <span className="task-line">{worktreeLine(item, words)}</span>
                </button>
                {using && <span className="task-summary-tag">{words.inUse}</span>}
              </div>
              {expanded && (
                <div className="worktree-actions">
                  {asking === item.id ? (
                    <>
                      <div className="task-stale">{words.loses(item)}</div>
                      <div className="worktree-buttons">
                        <button type="button" className="task-report worktree-danger" disabled={busy} onClick={() => void act(client.request({ type: "worktrees.discard", botId: bot.id, worktreeId: item.id, force: true })).then(() => setAsking(null))}>{words.discardAnyway}</button>
                        <button type="button" className="task-report" onClick={() => setAsking(null)}>{words.cancel}</button>
                      </div>
                    </>
                  ) : (
                    <div className="worktree-buttons">
                      {onReview && <button type="button" className="task-report" disabled={item.missing} onClick={() => onReview({ worktreeId: item.id, branch: item.branch, base: item.base, path: item.path })}>{look.review}</button>}
                      <button type="button" className="task-report" disabled={busy || item.missing} onClick={() => void act(client.request({ type: "worktrees.use", botId: bot.id, worktreeId: using ? null : item.id }))}>{using ? words.useFolder : words.workHere}</button>
                      <button type="button" className="task-report" disabled={busy || item.missing} onClick={() => void act(client.request({ type: "worktrees.terminal", botId: bot.id, worktreeId: item.id }))}>{words.terminal}</button>
                      <button type="button" className="task-report" disabled={busy || item.missing} onClick={() => void act(client.request({ type: "worktrees.merge", botId: bot.id, worktreeId: item.id }))}>{words.merge(item.base)}</button>
                      <button type="button" className="task-report" disabled={busy} onClick={() => void act(client.request({ type: "worktrees.discard", botId: bot.id, worktreeId: item.id })).then((result) => { if (result?.confirm) { setAsking(item.id); setNote(null); } })}>{words.discard}</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {note && <div className={`worktree-note${note.ok ? "" : " bad"}`} role="status">{note.text}</div>}
    </section>
  );
}
