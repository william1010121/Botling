import { ShellOverlay } from "./ShellOverlay";
// The left column's Phase 4b parts (1.x's SidePanels.swift): a bot's subagent rows under it
// (SubagentRows / SubagentRow: running ones and ones that ended in the last 10 minutes, at most 4
// with "Show N more", each with its settle button), the New bot form (NewBotForm), and a row's menu
// with "Remove bot…" (and, in 2.0, "Remove project…") behind a confirmation (1.x's confirmationDialog).
import { Fragment, useEffect, useState } from "react";
import { LISTED_AT_MOST, listedRows, type AgentTargetView, type BotView, type SubagentRowView } from "../contract";
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

export function SubagentRows({ bot, bots, nested = false, chat = null, look = "original", now, watching, shownBot = null, onOpen, onSettle, onOpenIn, onSettleIn, onAgentMenu, selection = null, onToggleSelect, onGroup, onCancelSelect }: {
  bot: BotView;
  /** Every bot: a sub bot's row has that sub bot's own subagents listed under it (project bot > sub bot > subagent). */
  bots?: BotView[];
  nested?: boolean;
  /** The bot whose chat is on screen and the subagent watched in it (for a nested bot's own rows). */
  chat?: { botId: string | null; watching: string | null } | null;
  /** Open / settle a row of another bot (a sub bot's own subagent); falls back to onOpen / onSettle. */
  onOpenIn?: (botId: string, row: SubagentRowView) => void;
  onSettleIn?: (botId: string, row: SubagentRowView) => void;
  look?: Look;
  now: number;
  /** The subagent shown in the chat's place, if one of this bot's is. */
  watching: string | null;
  /** The bot whose chat is on screen (a sub bot row is selected when its chat is). */
  shownBot?: string | null;
  onOpen: (row: SubagentRowView) => void;
  onSettle: (row: SubagentRowView) => void;
  /** A row's "⋯" (agentMoves: the row says whether it can move): opens its menu at the button, for the bot whose row it is. */
  onAgentMenu?: (botId: string, row: SubagentRowView, at: { x: number; y: number }) => void;
  /** "Select several…": the bot whose worker rows are being picked, and the picked ones; rows of that bot show a tick box. */
  selection?: { botId: string; ids: string[] } | null;
  onToggleSelect?: (botId: string, row: SubagentRowView) => void;
  /** "New sub bot with these…" for the picked rows, under a name. */
  onGroup?: (botId: string, name: string) => void;
  onCancelSelect?: () => void;
}) {
  // "Show more" lists every row; per bot, forgotten on restart.
  const [all, setAll] = useState(false);
  const [groupName, setGroupName] = useState("");
  const picking = selection?.botId === bot.id ? selection : null;
  const every = listedRows(bot.subagentRows, now, null);
  const more = Math.max(0, every.length - LISTED_AT_MOST);
  const rows = all && more > 0 ? every : every.slice(0, LISTED_AT_MOST);
  if (!rows.length) return null;
  return (
    <div className={`subagent-rows${nested ? " nested" : ""}`} data-bot={bot.id}>
      {rows.map((row) => {
        const sub = row.subBot ? bots?.find((candidate) => candidate.id === row.subBot) : undefined;
        return (
        <Fragment key={row.id}>
        <div className={`subagent-row${watching === row.id || (row.subBot && shownBot === row.subBot) ? " selected" : ""}${row.status === "running" ? " running" : ""}${row.subBot ? " sub-bot" : ""}`} data-subagent={row.id} {...(row.subBot ? { "data-sub-bot": row.subBot } : {})}>
          <button type="button" className="subagent-open" title={row.prompt} onClick={() => onOpen(row)}
            aria-label={row.subBot ? `Sub bot of ${bot.name}: ${row.title}` : `Subagent of ${bot.name}${row.head ? ` (${row.head === "agy" ? "Antigravity" : row.head === "codex" ? "Codex" : "Claude"})` : ""}: ${row.title || "Subagent"}, ${row.status}`}>
            <span className="subagent-arrow" aria-hidden="true"><Icon name="turnDownRight" size={11} /></span>
            <OwnerMark head={row.head} avatar={bot.avatar} look={look} />
            <span className="subagent-title">{row.title || "Subagent"}</span>
            {row.subBot && <span className="subagent-kind">sub bot</span>}
            {row.host && <span className="subagent-kind subagent-host" title={`It runs on ${row.host.name}; its reports come here`}>on {row.host.name}</span>}
            {row.waitingForNetwork && <span className="subagent-network">網路中斷</span>}
          </button>
          {!row.subBot && picking && row.agentId && <input type="checkbox" className="subagent-pick" checked={picking.ids.includes(row.id)} aria-label={`Pick ${row.title || "Subagent"}`}
            onChange={() => onToggleSelect?.(bot.id, row)} />}
          {!row.subBot && !picking && row.movable && onAgentMenu && <AgentMenuButton row={row} onMenu={(at) => onAgentMenu(bot.id, row, at)} />}
          {!row.subBot && !picking && <button type="button" className="subagent-settle" onClick={() => onSettle(row)}
            title={row.status === "running" ? "Settle: move to Settled in the right column (it keeps working)" : "Settle: move to Settled in the right column"}
            aria-label={`Settle subagent ${row.title}`}>
            <span className="settle-mark"><SubagentMark status={row.status} /></span>
            <span className={`settle-icon ${row.status}`} aria-hidden="true"><Icon name="clock" size={12} /><SubagentMark status={row.status === "running" ? "completed" : row.status} /></span>
          </button>}
        </div>
        {sub && <SubagentRows bot={sub} bots={bots} nested chat={chat} look={look} now={now} watching={chat?.botId === sub.id ? chat.watching : null} shownBot={shownBot}
          onOpen={(child) => (onOpenIn ?? ((_id, r) => onOpen(r)))(sub.id, child)} onSettle={(child) => (onSettleIn ?? ((_id, r) => onSettle(r)))(sub.id, child)}
          onOpenIn={onOpenIn} onSettleIn={onSettleIn} onAgentMenu={onAgentMenu} selection={selection} onToggleSelect={onToggleSelect} onGroup={onGroup} onCancelSelect={onCancelSelect} />}
        </Fragment>
        );
      })}
      {picking && (
        <form className="subagent-group" aria-label="New sub bot with these" onSubmit={(event) => { event.preventDefault(); if (groupName.trim() && picking.ids.length) onGroup?.(bot.id, groupName.trim()); }}
          onKeyDown={(event) => { if (event.key === "Escape") onCancelSelect?.(); }}>
          <input autoFocus value={groupName} placeholder="Sub bot name" aria-label="Sub bot name" onChange={(event) => setGroupName(event.target.value)} />
          <button type="submit" disabled={!groupName.trim() || !picking.ids.length} title="A new sub bot owns the picked agents; they keep running where they are">New sub bot with these ({picking.ids.length})</button>
          <button type="button" onClick={() => onCancelSelect?.()}>Cancel</button>
        </form>
      )}
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
export function BotMenu({ bot, at, onRemove, onClose, pinned, onTogglePin, onRestart, lang = null }: { bot: BotView; at: { x: number; y: number }; onRemove: () => void; onClose: () => void; pinned: boolean; onTogglePin: () => void; onRestart: () => void; lang?: string | null }) {
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
      <button type="button" role="menuitem" className="bot-menu-item" onClick={onRestart} title={lang === "zh-Hant" ? "在同一段對話中重新啟動，並載入最新的系統提示詞；正在進行的工作結束後才會生效" : "Starts it again in the same conversation with the current instructions; waits for work in progress to finish"}>{lang === "zh-Hant" ? "重新啟動 Bot" : "Restart bot"}</button>
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


/** A subagent row's "⋯": its agent menu (only shown when the row says whether it can move, i.e. with agentMoves on). */
export function AgentMenuButton({ row, onMenu }: { row: SubagentRowView; onMenu: (at: { x: number; y: number }) => void }) {
  return <button type="button" className="subagent-more-menu" aria-haspopup="menu" aria-label={`More for ${row.title || "Subagent"}`} title="More"
    onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); onMenu({ x: box.left, y: box.bottom + 2 }); }}>⋯</button>;
}

export type AgentTargets = { engine: "claude" | "codex" | "agy"; targets: AgentTargetView[] };
export type AgentMoveTo = { kind: "bot"; botId: string } | { kind: "newSubBot"; name: string } | { kind: "back" };

/**
 * A subagent row's menu (modeled on BotMenu): "Move to…" lists where it can go (`agent.targets`), with why not for the
 * ones it cannot go to, and a name field for a new sub bot. The agent keeps running where it is; only its owner changes
 * (a Claude subagent's work is handed to a new sub bot instead).
 */
export function AgentMenu({ row, at, load, onMove, onClose, onMessage, onStop, onSelectSeveral }: { row: SubagentRowView; at: { x: number; y: number }; load: () => Promise<AgentTargets>; onMove: (to: AgentMoveTo) => void; onClose: () => void;
  /** "Send a message…" / "Stop" (its owner's follow-up and stop) and "Select several…" (then "New sub bot with these…"). */
  onMessage?: (text: string) => void; onStop?: () => void; onSelectSeveral?: () => void }) {
  const [targets, setTargets] = useState<AgentTargets | null>(null);
  const [listing, setListing] = useState(false);
  const [writing, setWriting] = useState(false);
  const [words, setWords] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  useEffect(() => {
    const close = (event: Event) => { if (!(event.target instanceof Element && event.target.closest(".agent-menu"))) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", key); window.removeEventListener("blur", onClose); };
  }, [onClose]);
  const open = () => {
    setListing(true);
    if (!targets) load().then(setTargets, (error: unknown) => setFailed(error instanceof Error ? error.message : String(error)));
  };
  const cannot = row.movable && !row.movable.ok ? row.movable.reason ?? "It cannot be moved now." : null;
  const fresh = targets?.targets.find((target) => target.kind === "newSubBot");
  return (
    <ShellOverlay><div className="bot-menu agent-menu" role="menu" style={{ left: at.x, top: at.y }} aria-label={`${row.title || "Subagent"} menu`}>
      {!listing && !writing && row.agentId && onMessage && <button type="button" role="menuitem" className="bot-menu-item" title="Words for it: joined into its run while it works, or the start of its next run" onClick={() => setWriting(true)}>Send a message…</button>}
      {!listing && writing && <form className="agent-menu-name agent-menu-message" onSubmit={(event) => { event.preventDefault(); if (words.trim()) onMessage?.(words.trim()); }}>
          <textarea autoFocus rows={3} value={words} placeholder="Your words for it" aria-label="Message for the agent" onChange={(event) => setWords(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (words.trim()) onMessage?.(words.trim()); } }} />
          <button type="submit" disabled={!words.trim()}>Send</button>
        </form>}
      {!listing && !writing && row.agentId && onStop && row.status === "running" && <button type="button" role="menuitem" className="bot-menu-item destructive" title="Stops it (its work so far stays; no report is made)" onClick={onStop}>Stop</button>}
      {!listing && !writing && (row.agentId && (onMessage || onStop)) && <div className="bot-menu-rule" />}
      {!listing && !writing && <button type="button" role="menuitem" className="bot-menu-item" disabled={!!cannot} title={cannot ?? "Give it to another bot: it keeps running where it is, and its reports go there"} onClick={open}>Move to…</button>}
      {!listing && !writing && row.agentId && onSelectSeveral && <button type="button" role="menuitem" className="bot-menu-item" disabled={!!cannot} title="Pick several of these rows, then make one new sub bot that owns them all" onClick={onSelectSeveral}>Select several…</button>}
      {!listing && !writing && cannot && <div className="agent-menu-reason">{cannot}</div>}
      {listing && !targets && !failed && <div className="agent-menu-reason">Loading…</div>}
      {listing && failed && <div className="agent-menu-reason">{failed}</div>}
      {listing && targets && <>
        {targets.targets.filter((target) => target.kind !== "newSubBot").map((target) => (
          <button key={`${target.kind}:${target.botId}`} type="button" role="menuitem" className="bot-menu-item agent-target" disabled={!!target.disabled}
            title={target.disabled ?? (target.sameFolder ? target.folder : `Runs in ${target.folder}`)} data-target={target.botId ?? ""}
            onClick={() => onMove(target.kind === "back" ? { kind: "back" } : { kind: "bot", botId: target.botId! })}>
            {target.kind === "back" ? `Back to ${target.name}` : target.name}
            {target.disabled ? <span className="agent-target-why"> — {target.disabled}</span> : !target.sameFolder ? <span className="agent-target-why"> — runs in {target.folder}</span> : null}
          </button>
        ))}
        {fresh && <div className="bot-menu-rule" />}
        {fresh && (!naming
          ? <button type="button" role="menuitem" className="bot-menu-item" disabled={!!fresh.disabled} title={fresh.disabled ?? (fresh.mode === "handoff" ? "Its work is handed over through handoff.md to a new sub bot" : "A new sub bot owns it; it keeps running where it is")} onClick={() => setNaming(true)}>
              New sub bot…{fresh.disabled ? <span className="agent-target-why"> — {fresh.disabled}</span> : null}
            </button>
          : <form className="agent-menu-name" onSubmit={(event) => { event.preventDefault(); if (name.trim()) onMove({ kind: "newSubBot", name: name.trim() }); }}>
              <input autoFocus value={name} placeholder="Sub bot name" aria-label="Sub bot name" onChange={(event) => setName(event.target.value)} />
              <button type="submit" disabled={!name.trim()}>Move</button>
            </form>)}
      </>}
    </div></ShellOverlay>
  );
}
