// The Review view (core/review.ts): the files a worktree (or the project's working tree) changed, each as
// a unified or split diff with syntax colours, loaded one file at a time; a click on a line adds a comment,
// and "Send to agent" sends every pending comment to the bot that owns the worktree as one chat message.
// It takes the chat's place in the chat column, like the whiteboard.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BotView, ReviewDiffView, ReviewFilesView, ReviewScope } from "../contract";
import { Client, RequestFailed } from "./client";
import { languageOf, tokenize } from "./highlight";
import { formatReviewComments, type ReviewComment } from "./review-comments";
import { reviewWords, type ReviewWords } from "./review-text";

export interface ReviewTarget {
  /** The worktree (null: the project's main checkout). */
  worktreeId: string | null;
  branch: string | null;
  base: string | null;
  path: string | null;
}

type Line = ReviewDiffView["hunks"][number]["lines"][number];
type Side = ReviewComment["side"];
const anchorOf = (line: Line): { side: Side; number: number } => (line.t === "del" ? { side: "old", number: line.o ?? 0 } : { side: "new", number: line.n ?? 0 });
const keyOf = (path: string, side: Side, number: number) => `${path}\0${side}\0${number}`;
const SPLIT_KEY = "botling.review.split";
const readSplit = () => { try { return localStorage.getItem(SPLIT_KEY) === "1"; } catch { return false; } };

function Code({ text, language }: { text: string; language: string | null }) {
  return <>{tokenize(text, language).map((token, index) => (token.kind ? <span key={index} className={`tk-${token.kind}`}>{token.text}</span> : <Fragment key={index}>{token.text}</Fragment>))}</>;
}

/** Deleted and added runs side by side: the n-th deleted line beside the n-th added line. */
export function splitRows(lines: Line[]): { left: Line | null; right: Line | null }[] {
  const rows: { left: Line | null; right: Line | null }[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].t === "ctx") { rows.push({ left: lines[i], right: lines[i] }); i++; continue; }
    const del: Line[] = [], add: Line[] = [];
    while (i < lines.length && lines[i].t === "del") del.push(lines[i++]);
    while (i < lines.length && lines[i].t === "add") add.push(lines[i++]);
    for (let n = 0; n < Math.max(del.length, add.length); n++) rows.push({ left: del[n] ?? null, right: add[n] ?? null });
  }
  return rows;
}

export function Review({ client, bot, target, lang, onClose }: { client: Client; bot: BotView; target: ReviewTarget; lang: string | null; onClose: () => void }) {
  const words = reviewWords(lang);
  const isWorktree = target.worktreeId !== null;
  const [scope, setScope] = useState<ReviewScope>(isWorktree ? "branch" : "uncommitted");
  const [turn, setTurn] = useState<string | null>(null);
  const [files, setFiles] = useState<ReviewFilesView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, ReviewDiffView | "loading">>({});
  const [forced, setForced] = useState<Set<string>>(new Set());
  const [split, setSplit] = useState(readSplit);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  const loaded = useRef(0);

  // A different worktree starts over.
  useEffect(() => {
    setScope(target.worktreeId !== null ? "branch" : "uncommitted"); setTurn(null); setFiles(null); setSelected(null); setDiffs({}); setForced(new Set());
    setComments([]); setEditing(null); setNote(null);
  }, [target.worktreeId, bot.id]);

  useEffect(() => {
    const mine = ++loaded.current;
    setProblem(null);
    client.request({ type: "review.files", botId: bot.id, worktreeId: target.worktreeId, scope, ...(scope === "turn" && turn ? { turn } : {}) }).then((view) => {
      if (mine !== loaded.current) return;
      if (!view.ok) { setFiles(view.turns.length ? view : null); setProblem(view.message); return; }
      setFiles(view); setDiffs({}); setForced(new Set());
      setSelected((current) => (current && view.files.some((file) => file.path === current) ? current : view.files[0]?.path ?? null));
    }, (failure) => { if (mine === loaded.current) { setFiles(null); setProblem(failure instanceof RequestFailed ? failure.error.message : String((failure as Error).message ?? failure)); } });
  }, [client, bot.id, target.worktreeId, scope, turn, nonce]);

  const file = files?.files.find((candidate) => candidate.path === selected) ?? null;
  const diffKey = files && file ? `${files.from}|${files.to}|${file.path}|${forced.has(file.path) ? "f" : ""}` : null;
  useEffect(() => {
    if (!files || !file || !diffKey || diffs[diffKey]) return;
    setDiffs((current) => ({ ...current, [diffKey]: "loading" }));
    client.request({ type: "review.diff", botId: bot.id, worktreeId: target.worktreeId, from: files.from, to: files.to, path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), ...(forced.has(file.path) ? { force: true } : {}) }).then(
      (view) => setDiffs((current) => ({ ...current, [diffKey]: view })),
      (failure) => setDiffs((current) => ({ ...current, [diffKey]: { ok: false, message: failure instanceof RequestFailed ? failure.error.message : String((failure as Error).message ?? failure), path: file.path, binary: false, additions: 0, deletions: 0, tooLarge: false, truncated: false, hunks: [] } })),
    );
  }, [client, bot.id, target.worktreeId, files, file, diffKey, diffs, forced]);

  const chooseSplit = (next: boolean) => { setSplit(next); try { localStorage.setItem(SPLIT_KEY, next ? "1" : "0"); } catch { /* not kept */ } };
  const pickScope = (next: ReviewScope) => {
    setScope(next);
    if (next === "turn" && !turn) setTurn(files?.turns.at(-1)?.id ?? null);
  };
  const turns = files?.turns ?? [];
  const language = file ? languageOf(file.path) : null;
  const view = diffKey ? diffs[diffKey] : undefined;

  const begin = (key: string) => { setEditing(key); setDraft(""); setNote(null); };
  const addComment = (line: Line, path: string) => {
    const { side, number } = anchorOf(line);
    const text = draft.trim();
    if (!text) return;
    setComments((current) => [...current, { id: `${Date.now()}-${current.length}`, path, line: number, side, code: line.text, text }]);
    setEditing(null); setDraft("");
  };
  const send = async () => {
    if (!comments.length || sending) return;
    setSending(true);
    try {
      await client.request({ type: "chat.send", botId: bot.id, text: formatReviewComments({ branch: target.branch, base: scope === "branch" ? target.base : null, path: target.path }, comments) });
      setComments([]); setNote({ ok: true, text: words.sentTo(bot.name) });
    } catch (failure) {
      setNote({ ok: false, text: failure instanceof RequestFailed ? failure.error.message : words.sendFailed });
    } finally { setSending(false); }
  };

  const byKey = useMemo(() => {
    const map = new Map<string, ReviewComment[]>();
    for (const comment of comments) { const key = keyOf(comment.path, comment.side, comment.line); map.set(key, [...(map.get(key) ?? []), comment]); }
    return map;
  }, [comments]);
  const countFor = useCallback((path: string) => comments.filter((comment) => comment.path === path).length, [comments]);

  /** Comments already made on a line, then the editor when that line is the one being commented on. */
  const below = (line: Line, path: string, columns: number) => {
    const { side, number } = anchorOf(line);
    const key = keyOf(path, side, number);
    const here = byKey.get(key) ?? [];
    return (
      <>
        {here.map((comment) => (
          <tr key={comment.id} className="rv-comment-row"><td colSpan={columns}>
            <div className="rv-comment"><span className="rv-comment-text">{comment.text}</span>
              <button type="button" className="rv-link" onClick={() => setComments((current) => current.filter((candidate) => candidate.id !== comment.id))}>{words.remove}</button></div>
          </td></tr>
        ))}
        {editing === key && (
          <tr className="rv-comment-row"><td colSpan={columns}>
            <form className="rv-editor" onSubmit={(event) => { event.preventDefault(); addComment(line, path); }}>
              <textarea className="worktree-input rv-textarea" autoFocus rows={3} value={draft} placeholder={words.commentPlaceholder} aria-label={words.commentPlaceholder} maxLength={2000} onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Escape") setEditing(null); else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); addComment(line, path); } }} />
              <span className="worktree-buttons"><button type="submit" className="task-report" disabled={!draft.trim()}>{words.save}</button><button type="button" className="task-report" onClick={() => setEditing(null)}>{words.cancel}</button></span>
            </form>
          </td></tr>
        )}
      </>
    );
  };

  const gutter = (line: Line, path: string, text: string, side: Side) => {
    const key = keyOf(path, side, side === "old" ? line.o ?? 0 : line.n ?? 0);
    return <td className="rv-num"><button type="button" className="rv-add" title={words.addComment} aria-label={`${words.addComment} ${text}`} onClick={() => begin(key)}>{text}</button></td>;
  };

  const renderDiff = (diff: ReviewDiffView, path: string) => (
    <table className={`rv-table${split ? " split" : ""}`}>
      <tbody>
        {diff.hunks.map((hunk, h) => (
          <Fragment key={h}>
            <tr className="rv-hunk"><td colSpan={split ? 4 : 3}>{hunk.header}</td></tr>
            {split
              ? splitRows(hunk.lines).map((row, r) => (
                <Fragment key={r}>
                  <tr className="rv-row">
                    {row.left ? <>{gutter(row.left, path, String(row.left.o ?? ""), row.left.t === "del" ? "old" : "new")}<td className={`rv-code ${row.left.t}`}><Code text={row.left.text} language={language} /></td></> : <><td className="rv-num" /><td className="rv-code empty" /></>}
                    {row.right && row.right.t !== "ctx" ? <>{gutter(row.right, path, String(row.right.n ?? ""), "new")}<td className={`rv-code ${row.right.t}`}><Code text={row.right.text} language={language} /></td></>
                      : row.right ? <><td className="rv-num">{row.right.n}</td><td className="rv-code ctx"><Code text={row.right.text} language={language} /></td></>
                      : <><td className="rv-num" /><td className="rv-code empty" /></>}
                  </tr>
                  {row.left && below(row.left, path, 4)}
                  {row.right && row.right !== row.left && below(row.right, path, 4)}
                </Fragment>
              ))
              : hunk.lines.map((line, l) => (
                <Fragment key={l}>
                  <tr className="rv-row">
                    {gutter(line, path, String((line.t === "del" ? line.o : line.n) ?? ""), line.t === "del" ? "old" : "new")}
                    <td className="rv-mark">{line.t === "add" ? "+" : line.t === "del" ? "−" : ""}</td>
                    <td className={`rv-code ${line.t}`}><Code text={line.text} language={language} /></td>
                  </tr>
                  {below(line, path, 3)}
                </Fragment>
              ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );

  const title = target.branch ? words.title(target.branch) : words.mainTitle;
  const total = files ? files.files.length : 0;
  return (
    <section className="review" aria-label={title}>
      <div className="review-bar">
        <span className="review-title" title={target.path ?? undefined}>{title}</span>
        {isWorktree && (
          <div className="board-switch" role="group" aria-label={words.review}>
            <button type="button" aria-pressed={scope === "branch"} onClick={() => pickScope("branch")}>{words.scopeBranch(target.base ?? "base")}</button>
            <button type="button" aria-pressed={scope === "uncommitted"} onClick={() => pickScope("uncommitted")}>{words.scopeUncommitted}</button>
            <button type="button" aria-pressed={scope === "turn"} onClick={() => pickScope("turn")}>{words.scopeTurn}</button>
          </div>
        )}
        {scope === "turn" && (turns.length ? (
          <select className="worktree-input rv-select" aria-label={words.scopeTurn} value={turn ?? ""} onChange={(event) => setTurn(event.target.value)}>
            {turns.map((entry, index) => <option key={entry.id} value={entry.id}>{words.turnLabel(index + 1, new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</option>)}
          </select>
        ) : <span className="task-line">{words.noTurns}</span>)}
        <span className="review-gap" />
        <div className="board-switch" role="group" aria-label={words.unified}>
          <button type="button" aria-pressed={!split} onClick={() => chooseSplit(false)}>{words.unified}</button>
          <button type="button" aria-pressed={split} onClick={() => chooseSplit(true)}>{words.split}</button>
        </div>
        <button type="button" className="task-report" onClick={() => setNonce((n) => n + 1)}>{words.refresh}</button>
        <button type="button" className="task-report" onClick={onClose}>{words.close}</button>
      </div>
      {problem && <div className="worktree-note bad rv-problem" role="status">{problem}</div>}
      <div className="review-body">
        <nav className="rv-files" aria-label={words.review}>
          {files?.ok && <div className="rv-summary">{total ? words.summary(total, files.additions, files.deletions) : words.noChanges}{files.capped && <div>{words.capped}</div>}</div>}
          {files?.ok && files.files.map((entry) => (
            <button key={entry.path} type="button" className={`rv-file${entry.path === selected ? " selected" : ""}`} data-status={entry.status} title={entry.oldPath ? words.renamedFrom(entry.oldPath) : entry.path} onClick={() => { setSelected(entry.path); setEditing(null); }}>
              <span className="rv-status" data-status={entry.status} title={words.status[entry.status]}>{entry.status}</span>
              <span className="rv-name">{entry.path}</span>
              {countFor(entry.path) > 0 && <span className="task-summary-tag">{countFor(entry.path)}</span>}
              <span className="rv-stat"><span className="rv-plus">{entry.binary ? "" : `+${entry.additions}`}</span> <span className="rv-minus">{entry.binary ? "" : `−${entry.deletions}`}</span></span>
            </button>
          ))}
          {!files && !problem && <div className="task-none">{words.loading}</div>}
        </nav>
        <div className="rv-diff">
          {file && <div className="rv-file-head"><span className="rv-status" data-status={file.status}>{file.status}</span> <strong>{file.path}</strong>{file.oldPath && <span className="task-line"> · {words.renamedFrom(file.oldPath)}</span>}</div>}
          {file && (view === "loading" || !view) && <div className="task-none">{words.loading}</div>}
          {file && view && view !== "loading" && (
            !view.ok ? <div className="worktree-note bad">{view.message}</div>
              : view.binary ? <div className="task-none">{words.binary}</div>
              : view.tooLarge ? (
                <div className="rv-guard"><div className="task-stale">{words.tooLarge(view.additions + view.deletions)}</div>
                  <button type="button" className="task-report" onClick={() => setForced((current) => new Set(current).add(file.path))}>{words.showAnyway}</button></div>
              ) : <>{renderDiff(view, file.path)}{view.truncated && <div className="task-stale">{words.truncated}</div>}</>
          )}
          {files?.ok && !file && <div className="task-none">{words.noChanges}</div>}
        </div>
      </div>
      {(comments.length > 0 || note) && (
        <div className="review-send">
          {note && <span className={`worktree-note${note.ok ? "" : " bad"}`} role="status">{note.text}</span>}
          <span className="review-gap" />
          {comments.length > 0 && <>
            <span className="task-line">{words.pending(comments.length)}</span>
            <button type="button" className="task-report" disabled={sending} onClick={() => setComments([])}>{words.discardComments}</button>
            <button type="button" className="task-report review-primary" disabled={sending} onClick={() => void send()}>{sending ? words.sending : words.send}</button>
          </>}
        </div>
      )}
    </section>
  );
}

export type { ReviewWords };
