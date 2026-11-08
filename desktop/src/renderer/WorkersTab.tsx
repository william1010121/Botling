// Navigation v5, part 2: the right panel's Workers tab and the "<owner>'s workers" badge beside the Chat / Board switch.
// The tab lists the room's app-managed workers (Claude, Codex, Antigravity) by owner: the room expanded, its parent and
// sibling sub bots folded to one line each. A row opens its read-only log in the panel; the only action is
// "Ask <owner>", which sends your question to the owner bot as your message, never to the worker.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { BotView, SubagentRowView, SubagentView } from "../contract";
import {
  askOwnerText, clock, elapsed, filesChanged, ownerSummary, sectionedWorkers, shortPath, workerFamily, workerRowsOf, workersBadge,
} from "./worker-panel";

export type PanelTab = "details" | "workers";

export interface WorkersTabProps {
  bot: BotView;
  bots: BotView[];
  /** The worker's own record, read only (`subagent.view` on its owner). */
  onLoadWorker: (ownerId: string, workerId: string) => Promise<SubagentView>;
  /** Send `text` to the owner bot as your message. */
  onAskOwner: (ownerId: string, text: string) => Promise<void>;
  /** You opened a failed worker's log: the badge goes back to normal. */
  onSeen?: (workerId: string) => void;
}

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

function meta(view: SubagentView, now: number): string {
  const started = Date.parse(view.startedAt), endedAt = view.endedAt ? Date.parse(view.endedAt) : null;
  const head = view.status === "running" ? `Running · ${elapsed(now - started)}`
    : `${view.status === "completed" ? "Done" : view.status === "failed" ? "Failed" : "Stopped"} ${endedAt ? clock(endedAt) : ""}`.trim();
  const parts = [head, view.model, endedAt ? elapsed(endedAt - started) : null, view.outputTokens ? `${Math.round(view.outputTokens / 1000)}k tok` : null];
  return parts.filter(Boolean).join(" · ");
}

function WorkerLog({ owner, row, onBack, onLoad, onAsk, onSeen }: { owner: BotView; row: SubagentRowView; onBack: () => void } & { onLoad: WorkersTabProps["onLoadWorker"]; onAsk: WorkersTabProps["onAskOwner"]; onSeen?: (id: string) => void }) {
  const [view, setView] = useState<SubagentView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const [sent, setSent] = useState<"sending" | "sent" | string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => { if (live) setSlow(true); }, 300);
    onLoad(owner.id, row.id).then((loaded) => { if (live) { setView(loaded); setFailed(null); } }, (error: unknown) => { if (live) setFailed(String((error as Error)?.message ?? error)); })
      .finally(() => clearTimeout(timer));
    return () => { live = false; clearTimeout(timer); };
  }, [owner.id, row.id, row.status, row.endedAt, attempt]);
  // While it runs, read it again now and then: its steps grow.
  useEffect(() => {
    if (row.status !== "running") return;
    const timer = setInterval(() => setAttempt((n) => n + 1), 4_000);
    return () => clearInterval(timer);
  }, [row.status, row.id]);
  useEffect(() => { if (row.status === "failed") onSeen?.(row.id); }, [row.id, row.status]);
  useEffect(() => { if (asking) box.current?.focus(); }, [asking]);

  const send = () => {
    const words = question.trim();
    if (!words) return;
    setSent("sending");
    onAsk(owner.id, askOwnerText({ title: row.title || "Worker", id: row.id, ...(row.agentId ? { agentId: row.agentId } : {}) }, words))
      .then(() => { setSent("sent"); setQuestion(""); setAsking(false); }, (error: unknown) => setSent(String((error as Error)?.message ?? error)));
  };
  const now = Date.now();
  const files = view ? filesChanged(view.steps) : [];
  const lastStep = view?.steps.at(-1);
  const keys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" && !(event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); onBack(); }
  };
  return (
    <div className="wk-logpane" onKeyDown={keys}>
      <div className="wk-head"><button type="button" className="wk-back" onClick={onBack}>‹ Workers</button><span className="wk-gap" /><span className="wk-ro">read only</span></div>
      <div className="wk-log">
        <div className="wk-titleline"><StatusMark status={view?.status ?? row.status} /><b className="wk-log-title">{view?.title || row.title || "Worker"}</b><EngineMark engine={view?.engine ?? row.head} /><span className="wk-own">{possessive(owner.name)} worker</span></div>
        {view && <div className="wk-meta">{meta(view, now)}</div>}
        {!view && failed && (
          <div className="wk-box wk-error"><b>Couldn’t load this worker</b><span>{failed}</span>
            <button type="button" className="wk-btn2" onClick={() => { setFailed(null); setAttempt((n) => n + 1); }}>Try again</button></div>
        )}
        {!view && !failed && slow && <div className="wk-skeleton" aria-label="Loading"><i /><i /><i /></div>}
        {view && (
          <>
            {view.status === "completed" && <div className="wk-box wk-result"><div className="wk-lab">Result · handed back to {owner.name}</div>{view.result || "It handed nothing back."}</div>}
            {view.status === "running" && <div className="wk-box wk-now"><div className="wk-lab">Now</div>{lastStep?.title ?? "Starting…"}</div>}
            {view.status === "failed" && <div className="wk-box wk-fail"><div className="wk-lab">Failed</div>{view.result || [...view.steps].reverse().find((step) => step.failed)?.title || "It stopped with an error."}</div>}
            {view.status === "stopped" && <div className="wk-box wk-result"><div className="wk-lab">Stopped</div>{view.result || `${owner.name} stopped it.`}</div>}
            {files.length > 0 && (
              <div className="wk-files"><div className="wk-lab">Files changed · {files.length}</div>
                {files.map((file) => <div key={file} className="wk-fc" title={file}>{shortPath(file)}</div>)}</div>
            )}
            <div><div className="wk-lab">Steps · {view.steps.length + 1}</div>
              <ol className="wk-steps">
                <li><span className="wk-tm">{clock(Date.parse(view.startedAt))}</span><span><b>From {owner.name}:</b> “{view.prompt.split("\n")[0]}”</span></li>
                {view.steps.map((step) => (
                  <li key={step.id} className={step.failed ? "failed" : undefined}><span className="wk-tm">{step.time ? clock(Date.parse(step.time)) : ""}</span>
                    <span className="wk-mu">{step.kind === "message" && step.from ? `${step.from}: ` : ""}{step.title}</span></li>
                ))}
                {view.status === "completed" && <li><span className="wk-tm">{view.endedAt ? clock(Date.parse(view.endedAt)) : ""}</span><span>Handed back to {owner.name}</span></li>}
              </ol>
            </div>
          </>
        )}
      </div>
      {asking ? (
        <div className="wk-lf wk-ask-box">
          <textarea ref={box} rows={3} value={question} placeholder={`Ask ${owner.name} about ${row.title || "this worker"}…`} onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } if (event.key === "Escape") setAsking(false); }} />
          <div className="wk-ask-row">
            <span className="wk-tm">Goes to {owner.name}’s chat as your message.</span>
            <button type="button" className="wk-btn2" onClick={() => setAsking(false)}>Cancel</button>
            <button type="button" className="wk-ask-send" disabled={!question.trim() || sent === "sending"} onClick={send}>Send</button>
          </div>
        </div>
      ) : (
        <div className="wk-lf">
          <span className="wk-tm wk-hint">{sent === "sent" ? `Sent to ${owner.name}.` : sent && sent !== "sending" ? sent : `Workers take instructions only from ${owner.name}.`}</span>
          <button type="button" className="wk-ask" onClick={() => { setSent(null); setAsking(true); }}>Ask {owner.name}</button>
        </div>
      )}
    </div>
  );
}

/** The Workers tab's body: the list, or one worker's read-only log pushed in its place. */
export function WorkersTab({ bot, bots, onLoadWorker, onAskOwner, onSeen }: WorkersTabProps) {
  const [picked, setPicked] = useState<{ ownerId: string; workerId: string } | null>(null);
  const owner = picked ? bots.find((candidate) => candidate.id === picked.ownerId) ?? (bot.id === picked.ownerId ? bot : null) : null;
  const row = owner && picked ? owner.subagentRows.find((candidate) => candidate.id === picked.workerId) ?? null : null;
  if (owner && row) {
    return <WorkerLog owner={owner} row={row} onBack={() => setPicked(null)} onLoad={onLoadWorker} onAsk={onAskOwner} onSeen={onSeen} />;
  }
  return <WorkerList bot={bot} bots={bots.some((candidate) => candidate.id === bot.id) ? bots : [bot, ...bots]} onOpen={(chosen, chosenRow) => setPicked({ ownerId: chosen.id, workerId: chosenRow.id })} />;
}

/** The badge beside the Chat / Board switch: "<owner>'s workers · 2 running"; hidden with no worker today. */
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
    <button type="button" className={`workers-badge${on ? " on" : ""}`} data-tone={badge.tone} title={tip} aria-pressed={on}
      aria-label={`${possessive(bot.name)} workers: ${badge.count}${badge.extra ? `, ${badge.extra}` : ""}`} onClick={onClick}>
      <span className={`wk-s ${badge.tone === "today" ? "completed" : badge.tone === "failed" ? "failed" : "running"}`} aria-hidden="true">{badge.tone === "today" ? "✓" : badge.tone === "failed" ? "!" : ""}</span>
      <b>{possessive(bot.name)} workers</b><span className="cnt">{badge.count}</span>{badge.extra && <span className="wk-mu">· {badge.extra}</span>}
    </button>
  );
}
