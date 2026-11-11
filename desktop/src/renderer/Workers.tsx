// Navigation v5, part 2: the "<owner>'s workers" badge beside the Chat / Storage switch, its menu, and the bar under a
// worker watched in the main area. The menu lists the room's app-managed workers (Claude, Codex, Antigravity) by owner:
// the room expanded, its parent and sibling sub bots folded to one line each. A row opens the worker in the chat's place,
// read only, the same view a left-column click opens (the chat page renders its transcript like any chat). Under it,
// "Ask <owner>" sends your question to the owner bot as your message, never to the worker.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { BotView, SubagentRowView } from "../contract";
import { ShellOverlay } from "./ShellOverlay";
import { askState, clock, elapsed, ownerSummary, sectionedWorkers, shortPath, workerFamily, workerRowsOf, workersBadge, type AskWorker } from "./worker-panel";

const ENGINE = { claude: { mark: "C", name: "Claude" }, codex: { mark: "X", name: "Codex" }, agy: { mark: "A", name: "Antigravity" } } as const;
const possessive = (name: string) => `${name}’s`;

function StatusMark({ status }: { status: SubagentRowView["status"] }) {
  const glyph = status === "completed" ? "✓" : status === "failed" ? "!" : status === "stopped" ? "■" : "";
  return <span className={`wk-s ${status}`} aria-hidden="true">{glyph}</span>;
}

function EngineMark({ engine }: { engine: SubagentRowView["head"] | undefined }) {
  if (!engine) return null;
  return <span className={`wk-e ${engine}`} title={ENGINE[engine].name}>{ENGINE[engine].mark}</span>;
}

function OwnerMark({ bot }: { bot: BotView }) {
  return <span className={`wk-sq${bot.parent ? "" : " root"}`} aria-hidden="true">{(bot.name.trim()[0] ?? "?").toUpperCase()}</span>;
}

function WorkerRow({ row, now, onOpen }: { row: SubagentRowView; now: number; onOpen: () => void }) {
  const when = row.status === "running" ? elapsed(now - row.startedAt) : clock(row.endedAt ?? row.startedAt);
  const note = row.prompt.split("\n")[0] ?? "";
  return (
    <button type="button" className="wk-row" data-worker={row.id} data-status={row.status} onClick={onOpen} title={row.prompt}
      aria-label={`${row.title || "Worker"}, ${row.status}`}>
      <StatusMark status={row.status} />
      <span className="wk-nm">{row.title || "Worker"}</span>
      <EngineMark engine={row.head} />
      <span className="wk-nt">{note}</span>
      <span className="wk-tm">{when}</span>
    </button>
  );
}

function OwnerRows({ owner, now, onOpen }: { owner: BotView; now: number; onOpen: (row: SubagentRowView) => void }) {
  const [more, setMore] = useState(false);
  const { running, today, earlier } = sectionedWorkers(workerRowsOf(owner), now);
  const section = (name: string, rows: SubagentRowView[]) => rows.length > 0 && (
    <>
      <div className="wk-sec">{name} · {rows.length}</div>
      {rows.map((row) => <WorkerRow key={row.id} row={row} now={now} onOpen={() => onOpen(row)} />)}
    </>
  );
  return (
    <>
      {section("Running", running)}
      {section("Today", today)}
      {earlier.length > 0 && (
        <>
          <div className="wk-sec">Earlier · 7 days</div>
          {more ? earlier.map((row) => <WorkerRow key={row.id} row={row} now={now} onOpen={() => onOpen(row)} />)
            : <button type="button" className="wk-more" onClick={() => setMore(true)}>Show {earlier.length} more</button>}
        </>
      )}
      {!running.length && !today.length && !earlier.length && (
        <div className="wk-empty"><b>No workers today</b><span>When {owner.name} hands work to a worker, it shows up here.</span></div>
      )}
    </>
  );
}

function WorkerList({ bot, bots, onOpen }: { bot: BotView; bots: BotView[]; onOpen: (owner: BotView, row: SubagentRowView) => void }) {
  const now = Date.now();
  const { room, others } = workerFamily(bot, bots);
  const [open, setOpen] = useState<string[]>([]);
  const folded = others.filter((owner) => ownerSummary(workerRowsOf(owner), now).length > 0 || open.includes(owner.id));
  // ↑↓ move between rows.
  const keys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".wk-row")];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = rows[event.key === "ArrowDown" ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1)];
    if (next) { event.preventDefault(); next.focus(); }
  };
  return (
    <div className="wk-list" onKeyDown={keys}>
      <div className="wk-owner"><OwnerMark bot={room} />{room.name}<span className="wk-mu">· this room</span></div>
      <OwnerRows owner={room} now={now} onOpen={(row) => onOpen(room, row)} />
      {folded.length > 0 && <div className="wk-rule" />}
      {folded.map((owner) => open.includes(owner.id) ? (
        <div key={owner.id}>
          <button type="button" className="wk-owner wk-unfold" aria-expanded="true" onClick={() => setOpen(open.filter((id) => id !== owner.id))}>
            <OwnerMark bot={owner} />{owner.name}<span className="wk-mu">· {owner.parent ? "sub bot" : "project bot"}</span><span className="wk-gap" /><span className="wk-tm">▾</span>
          </button>
          <OwnerRows owner={owner} now={now} onOpen={(row) => onOpen(owner, row)} />
        </div>
      ) : (
        <button key={owner.id} type="button" className="wk-owner wk-folded" aria-expanded="false" onClick={() => setOpen([...open, owner.id])}>
          <OwnerMark bot={owner} />{owner.name}<span className="wk-mu">· {owner.parent ? "sub bot" : "project bot"}</span><span className="wk-gap" />
          {ownerSummary(workerRowsOf(owner), now).map((part) => <span key={part.tone} className={`wk-sum ${part.tone}`}>{part.text}</span>)}
          <span className="wk-tm">▸</span>
        </button>
      ))}
    </div>
  );
}

/** The badge beside the Chat / Storage switch: "<owner>'s workers · 2 running"; hidden with no worker today. `on` while its menu is open. */
export function WorkersBadge({ bot, bots, seen, on, onClick }: { bot: BotView; bots: BotView[]; seen: ReadonlySet<string>; on: boolean; onClick: () => void }) {
  const now = Date.now();
  const badge = workersBadge(workerRowsOf(bot), now, seen);
  if (!badge) return null;
  const { others } = workerFamily(bot, bots);
  const also = others.map((owner) => {
    const running = sectionedWorkers(workerRowsOf(owner), now).running.length;
    return running ? `${owner.name} ${running} running` : "";
  }).filter(Boolean);
  const tip = [badge.tip, also.length ? `Also: ${also.join(", ")}` : ""].filter(Boolean).join(" · ");
  return (
    <button type="button" className={`workers-badge${on ? " on" : ""}`} data-tone={badge.tone} title={tip} aria-expanded={on} aria-haspopup="dialog"
      aria-label={`${possessive(bot.name)} workers: ${badge.count}${badge.extra ? `, ${badge.extra}` : ""}`} onClick={onClick}>
      <span className={`wk-s ${badge.tone === "today" ? "completed" : badge.tone === "failed" ? "failed" : "running"}`} aria-hidden="true">{badge.tone === "today" ? "✓" : badge.tone === "failed" ? "!" : ""}</span>
      <b>{possessive(bot.name)} workers</b><span className="cnt">{badge.count}</span>{badge.extra && <span className="wk-mu">· {badge.extra}</span>}
      <span className="cnt-short" aria-hidden="true">{badge.count.split(" ")[0]}</span>
    </button>
  );
}

/** The badge's menu (and ⌘⇧W): the workers list; a row opens that worker in the main area. Esc or a click outside closes it. */
export function WorkersMenu({ bot, bots, onOpen, onClose }: { bot: BotView; bots: BotView[]; onOpen: (ownerId: string, row: SubagentRowView) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (event: Event) => {
      if (event.target instanceof Element && (box.current?.contains(event.target) || event.target.closest(".workers-badge"))) return;
      onClose();
    };
    document.addEventListener("pointerdown", away, true);
    box.current?.querySelector<HTMLButtonElement>(".wk-row")?.focus();
    return () => document.removeEventListener("pointerdown", away, true);
  }, []);
  const keys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
  };
  // The chat is a native view laid over the shell: like every menu over it, this one is a shell overlay, or the chat hides it.
  return (
    <ShellOverlay><div ref={box} className="wk-menu" role="dialog" aria-label={`${possessive(bot.name)} workers`} onKeyDown={keys}>
      <WorkerList bot={bot} bots={bots.some((candidate) => candidate.id === bot.id) ? bots : [bot, ...bots]} onOpen={(owner, row) => onOpen(owner.id, row)} />
    </div></ShellOverlay>
  );
}

/**
 * Under a worker watched in the main area: who it takes instructions from, the files it changed, and "Ask <owner>"
 * (the owner's chat, with this worker as a reference in its input box). Nothing here types to the worker.
 */
export function WorkerAskBar({ owner, ownerName, worker, files = [], onAsk, onOpenFile }: {
  owner: BotView | null; ownerName?: string; worker: SubagentRowView; files?: string[];
  onAsk: (ownerId: string, worker: AskWorker) => void; onOpenFile?: (path: string) => void;
}) {
  const ask = askState(owner, ownerName);
  return (
    <div className="wk-askbar" role="region" aria-label="Worker, read only">
      {files.length > 0 && (
        <div className="wk-files"><span className="wk-lab">Files changed · {files.length}</span>
          {files.map((file) => onOpenFile
            ? <button key={file} type="button" className="wk-fc" title={`${file} · open`} onClick={() => onOpenFile(file)}>{shortPath(file)}</button>
            : <span key={file} className="wk-fc" title={file}>{shortPath(file)}</span>)}
        </div>
      )}
      <div className="wk-lf">
        <span className="wk-ro">read only</span>
        <span className="wk-tm wk-hint">{ask.note}</span>
        <button type="button" className="wk-ask" disabled={!ask.ok} title={owner ? `${owner.name}’s chat, with this worker as a reference` : undefined}
          onClick={() => owner && onAsk(owner.id, { id: worker.id, title: worker.title || "Worker", ...(worker.agentId ? { agentId: worker.agentId } : {}) })}>Ask {owner?.name ?? ownerName ?? "its owner"}</button>
      </div>
    </div>
  );
}
