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
export function OwnerMark({ head, avatar, look = "original" }: { head: "claude" | "codex" | null; avatar: string; look?: Look }) {
  if (!head) return null;
  return <span className="subagent-owner" title={head === "codex" ? "Codex" : "Claude"} aria-hidden="true">
    <img src={faceURL({ avatar }, look, { engine: head })} alt="" />
    {look === "original" && <span className="subagent-owner-badge">{head === "codex" ? "X" : "C"}</span>}
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
            aria-label={`Subagent of ${bot.name}${row.head ? ` (${row.head === "codex" ? "Codex" : "Claude"})` : ""}: ${row.title || "Subagent"}, ${row.status}`}>
            <span className="subagent-arrow" aria-hidden="true"><Icon name="turnDownRight" size={11} /></span>
            <OwnerMark head={row.head} avatar={bot.avatar} look={look} />
            <span className="subagent-title">{row.title || "Subagent"}</span>
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
export function BotMenu({ bot, at, onRemove, onClose, pinned, onTogglePin, onEditGroup }: { bot: BotView; at: { x: number; y: number }; onRemove: () => void; onClose: () => void; pinned: boolean; onTogglePin: () => void; onEditGroup: () => void }) {
  useEffect(() => {
    const close = (event: Event) => { if (!(event.target instanceof Element && event.target.closest(".bot-menu"))) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", key); window.removeEventListener("blur", onClose); };
  }, [onClose]);
  return (
    <div className="bot-menu" role="menu" style={{ left: at.x, top: at.y }}>
      {bot.role === "group" ? (
        <>
          <button type="button" role="menuitem" className="bot-menu-item" onClick={onEditGroup}>Edit group…</button>
          <button type="button" role="menuitem" className="bot-menu-item destructive" onClick={onRemove}>Delete group…</button>
        </>
      ) : (
        <>
          <button type="button" role="menuitem" className="bot-menu-item" onClick={onTogglePin}>{pinned ? "Unpin" : "Pin"}</button>
          <div className="bot-menu-rule" />
          <button type="button" role="menuitem" className="bot-menu-item destructive" onClick={onRemove}>{bot.role === "bot" ? "Remove bot…" : "Remove project…"}</button>
        </>
      )}
    </div>
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
    <div className="dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="dialog" role="alertdialog" aria-labelledby="remove-title" aria-describedby="remove-message">
        <h2 id="remove-title">Remove "{bot.name}"?</h2>
        <p id="remove-message">It stops at once. Its notes stay in {bot.folder}.</p>
        <div className="dialog-buttons">
          <button type="button" className="dialog-cancel" onClick={onCancel} autoFocus>Cancel</button>
          <button type="button" className="dialog-destructive" onClick={onRemove}>{project ? "Remove project" : "Remove bot"}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Group chats (1.x's GroupRow, GroupForm and the delete confirmation)

/** A group's face: three people on a chip (1.x's person.3.fill). */
export function GroupFace({ size = 32 }: { size?: number }) {
  return (
    <span className="group-face" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 16 16" fill="currentColor">
        <circle cx="8" cy="5" r="2.4" /><circle cx="3.6" cy="6.4" r="1.8" /><circle cx="12.4" cy="6.4" r="1.8" />
        <path d="M3.8 13.5c0-2.4 1.9-4.2 4.2-4.2s4.2 1.8 4.2 4.2zM.6 12.6c0-1.7 1.2-3 2.8-3 .5 0 1 .1 1.4.4-.9.8-1.5 1.8-1.6 2.6zM15.4 12.6c0-1.7-1.2-3-2.8-3-.5 0-1 .1-1.4.4.9.8 1.5 1.8 1.6 2.6z" />
      </svg>
    </span>
  );
}

/** A group in the left column: its name, then who is writing or who is in it (1.x's GroupRow). */
export function GroupRow({ group, bots, selected, waiting = false, onSelect, onMenu }: { group: BotView; bots: BotView[]; selected: boolean; waiting?: boolean; onSelect: () => void; onMenu: (x: number, y: number) => void }) {
  const names = (group.members ?? []).map((id) => bots.find((bot) => bot.id === id)?.name).filter((name): name is string => !!name);
  const writing = group.guest ? bots.find((bot) => bot.id === group.guest)?.name ?? null : null;
  return (
    <div className="bot-row-wrap">
      <button className={`bot-row group-row${selected ? " selected" : ""}`} data-bot={group.id} data-group="1" aria-current={selected ? "page" : undefined}
        aria-label={`Group ${group.name}${waiting ? ", waiting on you" : ""}${group.unread && !selected ? `, ${group.unread} unread` : ""}`} onClick={onSelect}
        onContextMenu={(event) => { event.preventDefault(); onMenu(event.clientX, event.clientY); }}>
        <GroupFace />
        <span className="group-text">
          <span className="bot-name">{group.name}</span>
          {writing ? <span className="group-writing">{writing} is writing…</span> : <span className="group-members">{names.join(", ")}</span>}
        </span>
        <span className="bot-gap" />
        {group.unread > 0 && !selected && <span className="badge" aria-hidden="true">{group.unread}</span>}
      </button>
    </div>
  );
}

/** Making or changing a group: a name and the bots in it (1.x's GroupForm). */
export function GroupForm({ group, bots, look, onDone, faceOf }: {
  group: BotView | null; bots: BotView[]; look: "original" | "cute";
  onDone: (made: { name: string; members: string[] } | null) => void;
  faceOf: (bot: BotView) => string;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [picked, setPicked] = useState<Set<string>>(new Set(group?.members ?? []));
  const everyone = bots.filter((bot) => bot.role !== "group");
  const can = !!name.trim() && picked.size > 0;
  void look;
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onDone(null); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onDone]);
  return (
    <div className="dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onDone(null); }}>
      <form className="dialog group-form" aria-label={group ? "Edit group" : "New group"} onSubmit={(event) => { event.preventDefault(); if (can) onDone({ name, members: [...picked] }); }}>
        <h2>{group ? "Edit group" : "New group"}</h2>
        <input className="group-name-input" placeholder="Group name, e.g. Blog team" value={name} autoFocus onChange={(event) => setName(event.target.value)} aria-label="Group name" />
        <div className="group-who">Who is in it</div>
        <div className="group-pick">
          {everyone.map((bot) => (
            <label key={bot.id} className="group-member-pick">
              <input type="checkbox" checked={picked.has(bot.id)} aria-label={bot.name}
                onChange={(event) => { const next = new Set(picked); if (event.target.checked) next.add(bot.id); else next.delete(bot.id); setPicked(next); }} />
              <img src={faceOf(bot)} alt="" />
              <span>{bot.name}</span>
            </label>
          ))}
        </div>
        <div className="dialog-buttons">
          <button type="button" className="dialog-cancel" onClick={() => onDone(null)}>Cancel</button>
          <button type="submit" className="dialog-primary" disabled={!can}>{group ? "Save" : "Create"}</button>
        </div>
      </form>
    </div>
  );
}

/** "Delete the group "X"?" (1.x): its conversation is deleted; the bots keep their own chats and memory. */
export function DeleteGroupDialog({ group, onDelete, onCancel }: { group: BotView; onDelete: () => void; onCancel: () => void }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCancel]);
  return (
    <div className="dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="dialog" role="alertdialog" aria-labelledby="delete-group-title" aria-describedby="delete-group-message">
        <h2 id="delete-group-title">Delete the group "{group.name}"?</h2>
        <p id="delete-group-message">Its conversation is deleted. The bots in it keep their own chats and memory.</p>
        <div className="dialog-buttons">
          <button type="button" className="dialog-cancel" onClick={onCancel} autoFocus>Cancel</button>
          <button type="button" className="dialog-destructive" onClick={onDelete}>Delete group</button>
        </div>
      </div>
    </div>
  );
}
