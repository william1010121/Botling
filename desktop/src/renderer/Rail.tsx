import { ShellOverlay } from "./ShellOverlay";
// The left column's Phase 4b parts (1.x's SidePanels.swift): a bot's subagent rows under it
// (SubagentRows / SubagentRow: running ones and ones that ended in the last 10 minutes, at most 4
// with "Show N more", each with its settle button), the New bot form (NewBotForm), and a row's menu
// with "Remove bot…" (and, in 2.0, "Remove project…") behind a confirmation (1.x's confirmationDialog).
import { useEffect, useState } from "react";
import { LISTED_AT_MOST, listedRows, type BotView, type SubagentRowView } from "../contract";
import { Icon, SubagentMark } from "./icons";
import { faceURL, type Look } from "./avatars";

/** The clock the column's time-based rows go by: a tick every 30 s (1.x's TimelineView). */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** 1.x's SubagentOwnerMark: the parent's face, with its head identified in either look. */
export function OwnerMark({ head, avatar, look = "original" }: { head: "claude" | "codex" | "agy" | null; avatar: string; look?: Look }) {
  if (!head) return null;
  return <span className="subagent-owner" title={head === "agy" ? "Antigravity" : head === "codex" ? "Codex" : "Claude"} aria-hidden="true">
    <img src={faceURL({ avatar }, look, { engine: head })} alt="" />
    {look === "original" && <span className="subagent-owner-badge">{head === "agy" ? "A" : head === "codex" ? "X" : "C"}</span>}
  </span>;
}

export function SubagentRows({ bot, look = "original", now, watching, onOpen, onSettle }: {
  bot: BotView;
  look?: Look;
  now: number;
  /** The subagent shown in the chat's place, if one of this bot's is. */
  watching: string | null;
  onOpen: (row: SubagentRowView) => void;
  onSettle: (row: SubagentRowView) => void;
}) {
  // "Show more" lists every row; per bot, forgotten on restart.
  const [all, setAll] = useState(false);
  const every = listedRows(bot.subagentRows, now, null);
  const more = Math.max(0, every.length - LISTED_AT_MOST);
  const rows = all && more > 0 ? every : every.slice(0, LISTED_AT_MOST);
  if (!rows.length) return null;
  return (
    <div className="subagent-rows" data-bot={bot.id}>
      {rows.map((row) => (
        <div key={row.id} className={`subagent-row${watching === row.id ? " selected" : ""}${row.status === "running" ? " running" : ""}`} data-subagent={row.id}>
          <button type="button" className="subagent-open" title={row.prompt} onClick={() => onOpen(row)}
            aria-label={`Subagent of ${bot.name}${row.head ? ` (${row.head === "agy" ? "Antigravity" : row.head === "codex" ? "Codex" : "Claude"})` : ""}: ${row.title || "Subagent"}, ${row.status}`}>
            <span className="subagent-arrow" aria-hidden="true"><Icon name="turnDownRight" size={11} /></span>
            <OwnerMark head={row.head} avatar={bot.avatar} look={look} />
            <span className="subagent-title">{row.title || "Subagent"}</span>
            {row.waitingForNetwork && <span className="subagent-network">網路中斷</span>}
          </button>
          <button type="button" className="subagent-settle" onClick={() => onSettle(row)}
            title={row.status === "running" ? "Settle: move to Settled in the right column (it keeps working)" : "Settle: move to Settled in the right column"}
            aria-label={`Settle subagent ${row.title}`}>
            <span className="settle-mark"><SubagentMark status={row.status} /></span>
            <span className={`settle-icon ${row.status}`} aria-hidden="true"><Icon name="clock" size={12} /><SubagentMark status={row.status === "running" ? "completed" : row.status} /></span>
          </button>
        </div>
      ))}
      {more > 0 && (
        <button type="button" className="subagent-more" onClick={() => setAll(!all)}
          aria-label={all ? `Show fewer subagents of ${bot.name}` : `Show ${more} more subagents of ${bot.name}`}>
          {all ? "Show less" : `Show ${more} more`}
        </button>
      )}
    </div>
  );
}

/** A bot of its own: a name and what it is for (1.x's NewBotForm). It then sets up its own routines. */
export function NewBotForm({ onDone, busy }: { onDone: (made: { name: string; job: string } | null) => void; busy: boolean }) {
  const [name, setName] = useState("");
  const [job, setJob] = useState("");
  const canCreate = !!name.trim() && !!job.trim() && !busy;
  return (
    <form className="new-bot" aria-label="New bot" onSubmit={(event) => { event.preventDefault(); if (canCreate) onDone({ name, job }); }}
      onKeyDown={(event) => { if (event.key === "Escape") onDone(null); }}>
      <input className="new-bot-name" placeholder="Name, e.g. Morning news" value={name} autoFocus onChange={(event) => setName(event.target.value)} aria-label="Name" />
      <textarea className="new-bot-job" placeholder="Its job, e.g. every day at 08:00, the top 5 tech stories" rows={2} value={job} onChange={(event) => setJob(event.target.value)} aria-label="Its job"
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canCreate) onDone({ name, job }); } }} />
      <div className="new-bot-buttons">
        <button type="button" className="new-bot-cancel" onClick={() => onDone(null)}>Cancel</button>
        <button type="submit" className="new-bot-create" disabled={!canCreate}>Create</button>
      </div>
    </form>
  );
}

/** A row's menu (1.x's contextMenu): "Remove bot…" for a bot of its own, "Remove project…" for a project. */
export function BotMenu({ bot, at, onRemove, onClose, pinned, onTogglePin }: { bot: BotView; at: { x: number; y: number }; onRemove: () => void; onClose: () => void; pinned: boolean; onTogglePin: () => void }) {
  useEffect(() => {
    const close = (event: Event) => { if (!(event.target instanceof Element && event.target.closest(".bot-menu"))) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", key); window.removeEventListener("blur", onClose); };
  }, [onClose]);
  return (
    <ShellOverlay><div className="bot-menu" role="menu" style={{ left: at.x, top: at.y }}>
        <button type="button" role="menuitem" className="bot-menu-item" onClick={onTogglePin}>{pinned ? "Unpin" : "Pin"}</button>
      <div className="bot-menu-rule" />
      <button type="button" role="menuitem" className="bot-menu-item destructive" onClick={onRemove}>{bot.role === "bot" ? "Remove bot…" : "Remove project…"}</button>
    </div></ShellOverlay>
  );
}

/** "Remove "X"?" (1.x: "It stops at once. Its notes stay in {folder}."). Nothing on disk is deleted. */
export function RemoveDialog({ bot, onRemove, onCancel }: { bot: BotView; onRemove: () => void; onCancel: () => void }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCancel]);
  const project = bot.role !== "bot";
  return (
    <ShellOverlay><div className="dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="dialog" role="alertdialog" aria-labelledby="remove-title" aria-describedby="remove-message">
        <h2 id="remove-title">Remove "{bot.name}"?</h2>
        <p id="remove-message">It stops at once. Its notes stay in {bot.folder}.</p>
        <div className="dialog-buttons">
          <button type="button" className="dialog-cancel" onClick={onCancel} autoFocus>Cancel</button>
          <button type="button" className="dialog-destructive" onClick={onRemove}>{project ? "Remove project" : "Remove bot"}</button>
        </div>
      </div>
    </div></ShellOverlay>
  );
}

