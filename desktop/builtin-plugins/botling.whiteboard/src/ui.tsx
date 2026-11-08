// The main bot's whiteboard, drawn in botling.whiteboard's frame (the page this was, Whiteboard.tsx, moved out of the app):
// three layers (the approved Whiteboard redesign):
//   A. The summary: three numbers (bots, what waits on you, what runs), a donut (bots active /
//      waiting / asleep) and where the open work is (bots ranked by what waits on you).
//   B. Two lanes: "Waiting on you" (each bot with something for you lists every item: a question,
//      your call, a tool approval, with its age and a button to answer it) and "Running" (bots at
//      work: their latest action and what comes next). A bot both at work and waiting on you shows
//      once, in Waiting, marked Running.
//   C. The rest on a shelf, "Idle & asleep": a pill each (name, its last update,
//      "N wk quiet" after three weeks), dimmed; "Show details" opens a list (kept per user).
// A card shows one short line from the bot's memory, not its whole paragraph. Pressed, a card (or a pill,
// a row) grows into the bot's report, read by scrolling: Summary, Your call, Results, My calls ("Decided"), Next. Everything is what
// the bots keep themselves; a part with nothing in it is left out. A bot may give its card a picture
// of its own (<whiteboard>): one of its components, drawn as a 1×1 or 2×1 Board tile on its Running
// card, in the same sandboxed component frame as the chat's (`ccb.tile`); the report shows it too.
//
// It is written against React's API and runs on Preact (the build maps `react` to Botling's own copy, see
// ../build.json), so the unit tests run it on React. Keep to what both do the same.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ageLabel, askCount, boardLanes, CARD_LINE_WIDTH, description, drawnPicture, isRunning, laneStatus, lastActive, latestLine,
  MOST_PICTURES, nextSteps, openRanking, quietWeeks, shortLine, shortTime, shortTimeOf, waitingAsks,
  type Ask, type AskKind,
} from "./board";
import type { BoardView, Bot, Entry, Lang, Picture, Waiting } from "./types";

export { CARD_LINE_WIDTH };

const PATHS = { xmark: "M4.5 4.5l7 7M11.5 4.5l-7 7", arrowUpRight: "M5 11l6-6M6 5h5v5" } as const;
/** A small line icon, drawn in the current colour (the app's own, copied). */
function Icon({ name, size = 14 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" style={{ strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" }} aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

const WORDS: Record<Lang, Record<"showDetails" | "showLess" | "notify", string>> = {
  en: { showDetails: "Show details", showLess: "Show less", notify: "Notify" },
  "zh-Hant": { showDetails: "顯示詳情", showLess: "收起", notify: "我知道了" },
};
/** The board's own words in `lang` (English for anything missing). */
function say(lang: Lang | null | undefined, key: keyof (typeof WORDS)["en"]): string {
  return (WORDS[lang ?? "en"] ?? WORDS.en)[key];
}

/** The Idle & asleep shelf: its details list open or not, kept for the next start (by the plugin's program part). */
function useShelfOpen(api: BoardApi, kept: boolean | undefined): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState<boolean | null>(null);
  const choose = (next: boolean) => { setOpen(next); api.setShelf(next); };
  return [open ?? kept ?? false, choose];
}

/**
 * Asks the program part for the board's data now and every few seconds while it is shown. Each ask carries the
 * stamp of the board it has, and the answer is `same` (no bots) while nothing changed: the page then
 * neither compares nor redraws. Hidden windows pause polling and refresh when shown again; slow
 * replies cannot accumulate concurrent requests.
 */
function useBoardData(api: BoardApi, refreshMs: number): BoardView | null {
  const [data, setData] = useState<BoardView | null>(null);
  const stamp = useRef<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      if (!live || document.hidden || pending) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = true;
      void api.board(stamp.current).then((view) => {
        if (!live || view.same) return;
        stamp.current = view.stamp;
        setData(view);
      }, () => {}).finally(() => {
        pending = false;
        if (live && !document.hidden && refreshMs > 0) timer = setTimeout(load, refreshMs);
      });
    };
    const visibility = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (!document.hidden && refreshMs > 0) load();
    };
    document.addEventListener("visibilitychange", visibility);
    load();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [api, refreshMs]);
  return data;
}

/** A tooltip's place and words (the shelf's pills and rows, the ranking, the chart). */
interface Tip { x: number; y: number; content: ReactNode }

export interface WhiteboardProps {
  api: BoardApi;
  /** The time the page shows ages against; it moves on its own while the board is shown. */
  now?: number;
  /** How often the board asks again (ms); 0: only once (tests). */
  refreshMs?: number;
}

/** What the board asks of its frame's host (web.ts maps it onto `ccb`). */
export interface BoardApi {
  board(since?: string): Promise<BoardView>;
  /** "I know" for an item waiting on you: the same ignore as the right panel's x. */
  ignore(botId: string, text: string): Promise<void>;
  /** A message to the main bot, as the user's. */
  send(text: string): Promise<void>;
  openChat(botId: string): void;
  openResult(botId: string, url: string): void;
  /** A library component as a tile: the URL of its page, for a frame of this page's own. */
  tile(spec: { component: string; data: unknown; size: "1x1" | "2x1" | "2x2"; botId: string }): Promise<string>;
  /** Asks the user, on the app page's ApprovalSheet, to allow a bot's command. */
  approve(req: { botId: string; command: string; folder: string; card: string }): Promise<{ allowed: boolean }>;
  /** The command was allowed: Botling runs it (and again whenever the board is shown, at most every 30 s). */
  run(botId: string): Promise<void>;
  setShelf(open: boolean): void;
  onError(failure: unknown): void;
}

/** The clock the board's ages go by. */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const NO_WAITING: Waiting = { items: [], doing: {} };
const NO_BOTS: Bot[] = [];

export function Whiteboard({ api, now: given, refreshMs = 5_000 }: WhiteboardProps) {
  const data = useBoardData(api, refreshMs);
  const clock = useClock();
  const now = given ?? clock;
  const bots = data?.bots ?? NO_BOTS;
  const waiting = data?.waiting ?? NO_WAITING;
  const look = data?.look ?? "original";
  const lang = data?.lang ?? "en";
  const mainBotId = data?.mainBotId ?? "main";
  const byBot = useMemo(() => new Map((data?.entries ?? []).map((entry) => [entry.botId, entry])), [data]);
  const pins = useMemo(() => new Set(data?.pinned ?? []), [data]);
  const lanes = boardLanes(bots, byBot, waiting, pins);
  const [shelfOpen, setShelfOpen] = useShelfOpen(api, data?.shelfOpen);
  const [open, setOpen] = useState<{ botId: string; origin: string } | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const waitingLane = useRef<HTMLElement>(null);
  const openBot = open ? bots.find((bot) => bot.id === open.botId) ?? null : null;
  const cards = bots.filter((bot) => bot.role !== "main");
  const statusOf = (bot: Bot) => data?.statuses[bot.id] ?? { key: "asleep", text: "Asleep" };
  // The first pictures on the Running lane are drawn; past MOST_PICTURES a card shows its line.
  const pictured = new Set(lanes.running.filter((bot) => drawnPicture(byBot.get(bot.id))).slice(0, MOST_PICTURES).map((bot) => bot.id));

  // Notify: "I know". The item leaves the list (the same ignore as the right panel's x); nothing is sent to the bot.
  const notify = (ask: Ask) => { if (ask.ack) void api.ignore(ask.ack.botId, ask.ack.text).catch(api.onError); };

  const press = (bot: Bot, element: HTMLElement) => {
    // The report grows out of the card: its scale starts at the card's place on the canvas.
    const box = canvas.current?.getBoundingClientRect();
    const at = element.getBoundingClientRect();
    const origin = box ? `${Math.round(at.left - box.left + at.width / 2)}px ${Math.round(at.top - box.top + at.height / 2)}px` : "50% 0";
    setTip(null);
    setOpen({ botId: bot.id, origin });
  };
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);
  const tipFor = (content: ReactNode) => ({
    onPointerEnter: (event: React.PointerEvent) => setTip({ x: event.clientX, y: event.clientY, content }),
    onPointerMove: (event: React.PointerEvent) => setTip((current) => (current ? { ...current, x: event.clientX, y: event.clientY } : current)),
    onPointerLeave: () => setTip(null),
  });
  const face = (bot: Bot) => data?.faces[bot.id] ?? "";

  // Layer A's numbers.
  const asks = new Map(lanes.waiting.map((bot) => [bot.id, waitingAsks(bot, waiting, byBot.get(bot.id))]));
  const askTotal = [...asks.values()].reduce((sum, list) => sum + askCount(list), 0);
  const oldestAsk = Math.min(...[...asks.values()].flat().map((ask) => (ask.at ? Date.parse(ask.at) : NaN)).filter((at) => !Number.isNaN(at)));
  const waitingBots = cards.filter((bot) => asks.has(bot.id)).length;
  const runningBots = cards.filter((bot) => isRunning(bot, byBot.get(bot.id)));
  const alsoWaiting = runningBots.filter((bot) => asks.has(bot.id)).length;
  const activeBots = cards.filter((bot) => !asks.has(bot.id) && (isRunning(bot, byBot.get(bot.id)) || bot.phase !== "asleep")).length;
  const asleepBots = cards.length - waitingBots - activeBots;
  const ranking = openRanking(bots, byBot, waiting);

  return (
    <div className="whiteboard" aria-label="Whiteboard">
      <div className="wb-canvas" ref={canvas}>
        <div className="wb-board">
          <div className="wb-board-inner">
            <section className="wb-summary" aria-label="Summary">
              <Metric label="Bots" value={cards.length} sub={<><b>{activeBots}</b> active · {waitingBots} waiting · {asleepBots} asleep</>} />
              <Metric kind="waiting" label="Waiting on you" value={askTotal} dot="waiting"
                sub={askTotal ? <>from <b>{lanes.waiting.length}</b> bot{lanes.waiting.length === 1 ? "" : "s"}{Number.isFinite(oldestAsk) ? ` · oldest ${ageWords(now - oldestAsk)}` : ""}</> : "Nothing for you"}
                onPress={askTotal ? () => waitingLane.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }) : undefined} />
              <Metric kind="running" label="Running" value={runningBots.length} dot="working"
                sub={alsoWaiting ? <><b>{alsoWaiting}</b> also waiting on you</> : runningBots.length ? "At work now" : "Nothing running"} />
            </section>

            {cards.length > 0 && (
              <section className="wb-charts" aria-label="Charts">
                <div className="wb-panel">
                  <div className="wb-panel-head"><h3 className="wb-panel-title">At a glance</h3><span className="wb-panel-meta">Updated {shortTime(new Date(now).toISOString(), now)}</span></div>
                  <div className="wb-donuts">
                    <Donut label="bots" total={cards.length} parts={[{ key: "active", label: "Active", value: activeBots }, { key: "waiting", label: "Waiting", value: waitingBots }, { key: "asleep", label: "Asleep", value: asleepBots }]} />
                  </div>
                </div>
                <div className="wb-panel">
                  <div className="wb-panel-head"><h3 className="wb-panel-title">Where the open work is</h3><span className="wb-panel-meta">Asks, by bot</span></div>
                  <OpenRanking rows={ranking} face={face} tipFor={tipFor} onPress={press} />
                  <div className="wb-panel-foot">
                    <span><i className="sw waiting" />Waiting on you</span>
                    {ranking.length > RANKED && <span>+{ranking.length - RANKED} more</span>}
                  </div>
                </div>
              </section>
            )}

            {lanes.waiting.length > 0 && (
              <section ref={waitingLane} className="wb-section lane-waiting" aria-label="Waiting on you" id="wb-lane-waiting">
                <h3 className="wb-section-title"><span className="lane-dot" aria-hidden="true" />Waiting on you
                  <span className="wb-section-meta"> · {askTotal} thing{askTotal === 1 ? "" : "s"} from {lanes.waiting.length} bot{lanes.waiting.length === 1 ? "" : "s"} · oldest first</span></h3>
                <div className="lane-grid">
                  {lanes.waiting.map((bot) => (
                    <WaitingCard key={bot.id} bot={bot} data={byBot.get(bot.id)} waiting={waiting} asks={asks.get(bot.id) ?? []} now={now} face={face(bot)} lang={lang}
                      onPress={(element) => press(bot, element)} onOpenChat={api.openChat} onNotify={notify} />
                  ))}
                </div>
              </section>
            )}

            {lanes.running.length > 0 && (
              <section className="wb-section lane-running" aria-label="Running">
                <h3 className="wb-section-title"><span className="lane-dot blue" aria-hidden="true" />Running
                  <span className="wb-section-meta"> · {lanes.running.length} bot{lanes.running.length === 1 ? "" : "s"}</span></h3>
                <div className="lane-grid">
                  {lanes.running.map((bot) => (
                    <RunningCard key={bot.id} api={api} bot={bot} data={byBot.get(bot.id)} waiting={waiting} now={now} face={face(bot)}
                      picture={pictured.has(bot.id) ? drawnPicture(byBot.get(bot.id)) : null} onPress={(element) => press(bot, element)} />
                  ))}
                </div>
              </section>
            )}

            {lanes.quiet.length > 0 && (
              <QuietShelf bots={lanes.quiet} byBot={byBot} waiting={waiting} now={now} face={face} open={shelfOpen} lang={lang}
                onToggle={() => setShelfOpen(!shelfOpen)} onPress={press} tipFor={tipFor} />
            )}

            <MainSummary main={bots.find((bot) => bot.id === mainBotId)} face={data?.faces[mainBotId] ?? ""} reply={data?.mainReply ?? null} />
            {data && cards.length === 0 && <div className="wb-empty">No bots yet. Add a project or a bot of your own, and its card shows here.</div>}
          </div>
        </div>
        {open && openBot && (
          <div className="wb-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) setOpen(null); }}>
            <Report api={api} bot={openBot} data={byBot.get(openBot.id)} waiting={waiting} face={face(openBot)} now={now} origin={open.origin} status={statusOf(openBot)} lang={lang} onNotify={notify}
              onAllow={(picture) => void api.approve({ botId: openBot.id, command: picture.command!, folder: picture.folder!, card: picture.name })
                .then(({ allowed }) => (allowed ? api.run(openBot.id) : undefined)).catch(api.onError)}
              onClose={() => setOpen(null)} onOpenChat={(id) => { setOpen(null); api.openChat(id); }} />
          </div>
        )}
      </div>
      {tip && (
        <div className="wb-tip" role="tooltip" style={{ left: Math.max(8, Math.min(tip.x + 12, (typeof window === "undefined" ? 1e4 : window.innerWidth) - 268)), top: tip.y + 16 }}>{tip.content}</div>
      )}
      <WhiteboardComposer api={api} />
    </div>
  );
}

/** "2 days", "3 hours", "20 minutes": how long the oldest thing has waited. */
function ageWords(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  const [n, unit] = minutes < 60 ? [minutes, "minute"] : minutes < 48 * 60 ? [Math.floor(minutes / 60), "hour"] : [Math.floor(minutes / 1440), "day"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

type TipFor = (content: ReactNode) => Record<string, unknown>;

function Metric({ label, value, sub, kind, dot, onPress }: { label: string; value: number; sub: ReactNode; kind?: "waiting" | "running"; dot?: string; onPress?: () => void }) {
  const body = (
    <>
      <span className="wb-metric-l">{dot && <span className="now-dot" data-status={dot} aria-hidden="true" />}{label}</span>
      <span className="wb-metric-n">{value}</span>
      <span className="wb-metric-s">{sub}</span>
      {onPress && <span className="wb-metric-go" aria-hidden="true">Review ↓</span>}
    </>
  );
  const className = `wb-metric${kind ? ` ${kind}` : ""}${kind === "waiting" && value === 0 ? " none" : ""}`;
  return onPress
    ? <button type="button" className={className} data-metric={label} onClick={onPress} aria-label={`${value} waiting on you: review`}>{body}</button>
    : <div className={className} data-metric={label}>{body}</div>;
}

/** A ring of parts (bots active / waiting / asleep) with the total in it and a legend. */
function Donut({ label, total, parts }: { label: string; total: number; parts: { key: string; label: string; value: number }[] }) {
  const radius = 40;
  const length = 2 * Math.PI * radius;
  const sum = parts.reduce((all, part) => all + part.value, 0);
  let at = 0;
  return (
    <div className="wb-donut" data-donut={label}>
      <svg width="104" height="104" viewBox="0 0 100 100" role="img" aria-label={`${label}: ${parts.map((part) => `${part.label} ${part.value}`).join(", ")}`}>
        <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--chip)" style={{ strokeWidth: "11" }} />
        {sum > 0 && parts.filter((part) => part.value > 0).map((part) => {
          const span = (part.value / sum) * length;
          const shown = parts.filter((candidate) => candidate.value > 0).length > 1 ? Math.max(1.5, span - 2.5) : span;
          const arc = <circle key={part.key} className={`arc ${part.key}`} cx="50" cy="50" r={radius} fill="none" style={{ strokeWidth: "11", strokeDasharray: `${shown} ${length - shown}`, strokeDashoffset: String(-at) }} transform="rotate(-90 50 50)" />;
          at += span;
          return arc;
        })}
        <text x="50" y="50" style={{ textAnchor: "middle", fontSize: "19px", fontWeight: "600" }} fill="var(--text)" className="wb-donut-n">{total}</text>
        <text x="50" y="64" style={{ textAnchor: "middle", fontSize: "9.5px" }} fill="var(--faint)">{label}</text>
      </svg>
      <ul className="wb-legend">
        {parts.map((part) => <li key={part.key}><span className={`sw ${part.key}`} />{part.label}<span className="v">{part.value}</span></li>)}
      </ul>
    </div>
  );
}

const RANKED = 6;

/** Where the open work is: a bar per bot (what waits on you), the most first. */
function OpenRanking({ rows, face, tipFor, onPress }: { rows: ReturnType<typeof openRanking>; face: (bot: Bot) => string; tipFor: TipFor; onPress: (bot: Bot, element: HTMLElement) => void }) {
  const top = rows.slice(0, RANKED);
  const peak = Math.max(1, ...top.map((row) => row.waiting));
  if (!top.length) return <p className="wb-panel-empty">Nothing open right now.</p>;
  return (
    <ul className="wb-rank">
      {top.map(({ bot, waiting }) => (
        <li key={bot.id} data-bot={bot.id} onClick={(event) => onPress(bot, event.currentTarget)}
          {...tipFor(<><span className="tt">{bot.name}</span><br /><span className="ts">{waiting} waiting on you</span></>)}>
          <span className="wb-rank-name"><img src={face(bot)} alt="" />{bot.name}</span>
          <span className="wb-rank-track" aria-hidden="true">
            {waiting > 0 && <span className="fill-waiting" style={{ width: `${(waiting / peak) * 100}%` }} />}
          </span>
          <span className="wb-rank-v" aria-label={`${waiting} waiting on you`}><b>{waiting}</b></span>
        </li>
      ))}
    </ul>
  );
}

const MARK = { done: "✓", now: "→", waiting: "?" } as const;

/** The card's latest action line (one line or two). */
function Latest({ bot, data, waiting, one }: { bot: Bot; data: Entry | undefined; waiting: Waiting; one?: boolean }) {
  const line = latestLine(bot, data, waiting);
  if (!line) return <span className={`wb-latest none${one ? " one" : ""}`}><span className="txt">Nothing written yet</span></span>;
  return (
    <span className={`wb-latest${one ? " one" : ""}`} data-kind={line.kind ?? "line"}>
      {line.kind && <span className={`mark ${line.kind}`} aria-hidden="true">{MARK[line.kind]}</span>}
      <span className="txt">{line.text}</span>
    </span>
  );
}

const KIND_LABEL: Record<AskKind, string> = { question: "Question", call: "Your call", approval: "Approval" };
const KIND_BUTTON = { call: "Notify", approval: "Review" };
/** Questions stay in the conversation, reached through the card/report navigation. Notify only acknowledges; Review opens the approval. */
function AskButton({ ask, lang, onOpenChat, onNotify }: { ask: Ask; lang?: Lang | null; onOpenChat: (botId: string) => void; onNotify: (ask: Ask) => void }) {
  if (ask.kind === "question") return null;
  if (ask.kind === "call" && ask.ack) return <button type="button" className="wb-ask-open notify" onClick={() => onNotify(ask)}>{say(lang, "notify")}</button>;
  return <button type="button" className="wb-ask-open" onClick={() => onOpenChat(ask.open)}>{KIND_BUTTON[ask.kind]}</button>;
}
/** A card lists at most this many asks; the rest are counted. */
const MOST_ASKS = 4;

/** A bot with something waiting on you: each item with its kind, age and a button to answer it in its chat. */
function WaitingCard({ bot, data, waiting, asks, now, face, lang, onPress, onOpenChat, onNotify }: {
  bot: Bot; data: Entry | undefined; waiting: Waiting; asks: Ask[]; now: number; face: string; lang?: Lang | null;
  onPress: (element: HTMLElement) => void; onOpenChat: (botId: string) => void; onNotify: (ask: Ask) => void;
}) {
  const status = laneStatus(bot, data);
  const when = shortTime(bot.lastActivity, now);
  return (
    <article className="wb-card ask-card waiting" data-bot={bot.id} aria-label={`${bot.name}: ${askCount(asks)} waiting on you`}>
      <button type="button" className="wb-card-head wb-card-open" onClick={(event) => onPress(event.currentTarget)} title={`${bot.name}'s report`}>
        <img className="wb-face" src={face} alt="" />
        <span className="wb-card-name">{bot.name}</span>
        <span className="wb-pill">{askCount(asks)} waiting</span>
        <span className="wb-status"><span className="now-dot" data-status={status.key} aria-hidden="true" />{status.text}</span>
        {when && <span className="wb-card-time">{when}</span>}
      </button>
      <ul className="wb-asks">
        {asks.slice(0, MOST_ASKS).map((ask) => {
          const age = ageLabel(ask.at, now);
          return (
            <li key={ask.key} className={`wb-ask ${ask.kind}`} data-kind={ask.kind}>
              <span className="wb-ask-kind">{KIND_LABEL[ask.kind]}</span>
              {age && <span className="wb-ask-age">{age === "now" ? "just now" : `${age} ago`}</span>}
              <span className="wb-ask-text">{ask.code !== null ? <>{ask.text === "Bash" ? "Allow " : `Allow ${ask.text}: `}<code>{ask.code}</code></> : ask.text}</span>
              <AskButton ask={ask} lang={lang} onOpenChat={onOpenChat} onNotify={onNotify} />
            </li>
          );
        })}
        {asks.length > MOST_ASKS && <li className="wb-ask-more">+{askCount(asks.slice(MOST_ASKS))} more in the report</li>}
      </ul>
      <span className="wb-card-foot">
        <Latest bot={bot} data={data} waiting={waiting} one />
      </span>
    </article>
  );
}

/** A bot at work: its short line and what comes next. */
function RunningCard({ api, bot, data, waiting, now, face, picture, onPress }: {
  api: BoardApi; bot: Bot; data: Entry | undefined; waiting: Waiting; now: number; face: string;
  picture: Picture | null; onPress: (element: HTMLElement) => void;
}) {
  const next = data ? nextSteps(data)[0] : undefined;
  const when = shortTime(bot.lastActivity, now);
  const line = latestLine(bot, data, waiting);
  return (
    <button type="button" className={`wb-card run-card${picture ? ` pictured${picture.size === "2x1" ? " wide" : ""}` : ""}`} data-bot={bot.id} onClick={(event) => onPress(event.currentTarget)}
      aria-label={[`${bot.name}'s report`, "Running", line?.text].filter(Boolean).join(", ")}>
      <span className="wb-card-head">
        <img className="wb-face" src={face} alt="" />
        <span className="wb-card-name">{bot.name}</span>
        {when && <span className="wb-card-time">{when}</span>}
      </span>
      {picture && <PictureFrame api={api} botId={bot.id} picture={picture} size={picture.size} title={`${bot.name}'s picture`} />}
      <Latest bot={bot} data={data} waiting={waiting} one />
      <span className="wb-next">{next ? `Next · ${next}` : ""}</span>
      <span className="wb-card-foot">
        <span className="wb-status"><span className="now-dot" data-status="working" aria-hidden="true" />Running</span>
      </span>
    </button>
  );
}

/** Idle & asleep: a dimmed pill per bot; "Show details" opens a list instead (kept per user). */
function QuietShelf({ bots, byBot, waiting, now, face, open, lang, onToggle, onPress, tipFor }: {
  bots: Bot[]; byBot: ReadonlyMap<string, Entry>; waiting: Waiting; now: number; face: (bot: Bot) => string; open: boolean; lang?: Lang | null;
  onToggle: () => void; onPress: (bot: Bot, element: HTMLElement) => void; tipFor: TipFor;
}) {
  const today = new Date(now).toDateString();
  const todayCount = bots.filter((bot) => { const at = lastActive(bot, byBot.get(bot.id)); return at !== null && new Date(at).toDateString() === today; }).length;
  const tip = (bot: Bot) => {
    const data = byBot.get(bot.id);
    const line = latestLine(bot, data, waiting);
    const about = description(bot, data);
    return <><span className="tt">{bot.name}</span> <span className="ts">· {bot.phase === "asleep" ? "Asleep" : "Ready"}</span>{about && <><br />{about}</>}
      {line && <><br /><span className="ts">{line.kind ? `${MARK[line.kind]} ` : ""}{line.text}</span></>}</>;
  };
  return (
    <section className={`wb-section lane-quiet${open ? " open" : ""}`} aria-label="Idle and asleep">
      <h3 className="wb-section-title">Idle &amp; asleep<span className="wb-section-meta"> · {bots.length} bot{bots.length === 1 ? "" : "s"}{todayCount ? ` · ${todayCount} today` : ""}</span>
        <button type="button" className="wb-section-act wb-shelf-toggle" aria-expanded={open} onClick={onToggle}>
          {say(lang, open ? "showLess" : "showDetails")}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" style={{ strokeWidth: "1.5" }} aria-hidden="true"><path d={open ? "M2 6.5l3-3 3 3" : "M2 3.5l3 3 3-3"} /></svg>
        </button>
      </h3>
      {open ? (
        <div className="quiet-list" role="table" aria-label="Idle and asleep bots">
          <div className="quiet-row quiet-head" role="row"><span /><span>Bot</span><span className="a">Latest</span><span className="t">Updated</span></div>
          {bots.map((bot) => {
            const data = byBot.get(bot.id);
            const line = latestLine(bot, data, waiting);
            return (
              <div key={bot.id} role="row" tabIndex={0} className={`quiet-row${bot.phase !== "asleep" ? " ready" : ""}`} data-bot={bot.id}
                onClick={(event) => onPress(bot, event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter") onPress(bot, event.currentTarget); }} {...tipFor(tip(bot))}>
                <img src={face(bot)} alt="" />
                <span className="n">{bot.name}</span>
                <span className="a">{line ? `${line.kind ? `${MARK[line.kind]} ` : ""}${line.text}` : ""}</span>
                <span className="t">{shortTimeOf(lastActive(bot, data), now)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="quiet-pills">
          {bots.map((bot) => {
            const data = byBot.get(bot.id);
            const weeks = quietWeeks(bot, data, now);
            const when = shortTimeOf(lastActive(bot, data), now);
            return (
              <button key={bot.id} type="button" className={`quiet-pill${bot.phase !== "asleep" ? " ready" : ""}`} data-bot={bot.id}
                aria-label={`${bot.name}, ${bot.phase === "asleep" ? "asleep" : "ready"}${when ? `, updated ${when}` : ""}: ${description(bot, data)}`}
                onClick={(event) => onPress(bot, event.currentTarget)} {...tipFor(tip(bot))}>
                <img src={face(bot)} alt="" /><span className="name">{bot.name}</span>
                {when && <span className="when">{when}</span>}
                {weeks !== null && <span className="stale">· {weeks} wk quiet</span>}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * A bot's picture: its component as a Board tile (read only, filling the frame), on a card page the app page serves
 * (`ccb.tile`: the core finds its pictures, main serves the page once). The tile is a sandboxed frame of its own; what the
 * component posts (answers, saves) goes nowhere.
 */
function PictureFrame({ api, botId, picture, size, title }: { api: BoardApi; botId: string; picture: Picture; size: "1x1" | "2x1" | "2x2"; title: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let data: unknown = null;
    try { data = JSON.parse(picture.data); } catch { /* drawn with nothing */ }
    api.tile({ component: picture.name, data, size, botId }).then((page) => { if (live) setUrl(page); }, () => {});
    return () => { live = false; };
  }, [api, botId, picture.name, picture.data, size]);
  return (
    <span className={`wb-picture wb-picture-${size}`} aria-hidden={url ? undefined : true}>
      {url && <iframe className="wb-picture-frame" sandbox="allow-scripts" src={url} title={title} tabIndex={-1} />}
    </span>
  );
}

/** The main bot's latest reply (to what you asked in the board's input), at the board's end. */
function MainSummary({ main, face, reply }: { main: Bot | undefined; face: string; reply: string | null }) {
  if (!main || !reply?.trim()) return null;
  return (
    <section className="wb-main" aria-label="Main bot summary">
      <span className="wb-main-head"><img className="wb-face" src={face} alt="" />{main.name} · latest reply</span>
      <span className="wb-main-reply">{shortLine(reply, 2 * CARD_LINE_WIDTH)}</span>
    </section>
  );
}

const SECTIONS = [["sum", "Summary"], ["ask", "Your call"], ["made", "Results"], ["decided", "My calls"], ["next", "Next"]] as const;
type ReportSection = (typeof SECTIONS)[number][0];

function Report({ api, bot, data, waiting, face, now, origin, status, lang, onClose, onOpenChat, onNotify, onAllow }: {
  api: BoardApi;
  bot: Bot; data: Entry | undefined; waiting: Waiting; face: string; now: number; origin: string; status: { key: string; text: string }; lang?: Lang | null;
  onClose: () => void; onOpenChat: (botId: string) => void; onNotify: (ask: Ask) => void; onAllow: (picture: Picture) => void;
}) {
  const picture = drawnPicture(data);
  // Its picture's command waits for your OK: what would run where, and Allow.
  const asking = data?.picture?.status === "approve" && data.picture.command && data.picture.folder ? data.picture : null;
  const body = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const asks = waitingAsks(bot, waiting, data);
  const waitingTotal = askCount(asks);
  const next = data ? nextSteps(data) : [];
  const status0 = data?.currentStatus ?? [];
  const has: Record<ReportSection, boolean> = {
    sum: status0.length > 0 || !!picture || !!asking,
    ask: waitingTotal > 0,
    made: (data?.results.length ?? 0) > 0,
    decided: (data?.decided.length ?? 0) > 0,
    next: next.length > 0,
  };
  const shown = SECTIONS.filter(([id]) => has[id]);
  const [current, setCurrent] = useState<ReportSection | null>(shown[0]?.[0] ?? null);
  useLayoutEffect(() => { article.current?.focus({ preventScroll: true }); }, []);
  const jump = (id: ReportSection) => {
    setCurrent(id);
    const target = body.current?.querySelector<HTMLElement>(`[data-part="${id}"]`);
    if (target && body.current) body.current.scrollTop = target.offsetTop - body.current.offsetTop;
  };
  const when = shortTime(bot.lastActivity, now);
  return (
    <article ref={article} tabIndex={-1} className="wb-report" data-bot={bot.id} style={{ transformOrigin: origin }} aria-label={`${bot.name}'s report`}>
      <header className="wb-report-head">
        <div className="wb-report-top">
          <img className="wb-report-face" src={face} alt="" />
          <span className="wb-report-title">
            <span className="wb-report-name">{bot.name}'s report</span>
            <span className="wb-report-sub"><span className="now-dot" data-status={status.key} aria-hidden="true" />{status.text}{when ? ` · ${when}` : ""}</span>
          </span>
          <button type="button" className="wb-report-chat" onClick={() => onOpenChat(bot.id)}>Open chat</button>
          <button type="button" className="wb-report-close" aria-label="Shrink back to the board" title="Back to the board (Esc)" onClick={onClose}><Icon name="xmark" size={13} /></button>
        </div>
        {shown.length > 1 && (
          <nav className="wb-toc" aria-label="Parts of the report">
            {shown.map(([id, label]) => (
              <button key={id} type="button" className={`wb-toc-chip${current === id ? " on" : ""}`} onClick={() => jump(id)}>
                {id === "ask" ? `${label} ${waitingTotal}` : label}
              </button>
            ))}
          </nav>
        )}
      </header>
      <div className="wb-report-body" ref={body}>
        {shown.length === 0 && <p className="wb-report-empty">{bot.name} has not written a status or results yet.</p>}
        {has.sum && (
          <section data-part="sum" className="wb-part">
            {picture && <PictureFrame api={api} botId={bot.id} picture={picture} size="2x2" title={`${bot.name}'s picture`} />}
            {asking && (
              <div className="wb-picture-ask">
                <span className="wb-ask-text">Its picture comes from <code>{asking.command}</code>, run in {asking.folder}. It runs once you allow it.</span>
                <button type="button" className="wb-ask-open" onClick={() => onAllow(asking)}>Allow and run</button>
              </div>
            )}
            {status0.map((line, index) => <p key={index} className="wb-sum-line">{line}</p>)}
          </section>
        )}
        {has.ask && (
          <section data-part="ask" className="wb-part">
            <h4 className="wb-part-title ask">Your call</h4>
            {asks.map((ask) => {
              const age = ageLabel(ask.at, now);
              return (
                <div key={ask.key} className={`wb-ask ${ask.kind}`} data-kind={ask.kind}>
                  <span className="wb-ask-kind">{KIND_LABEL[ask.kind]}</span>
                  {age && <span className="wb-ask-age">{age === "now" ? "just now" : `${age} ago`}</span>}
                  <span className="wb-ask-text">{ask.code !== null ? <>{ask.text === "Bash" ? "Allow " : `Allow ${ask.text}: `}<code>{ask.code}</code></> : ask.text}</span>
                  <AskButton ask={ask} lang={lang} onOpenChat={onOpenChat} onNotify={onNotify} />
                </div>
              );
            })}
          </section>
        )}
        {has.made && (
          <section data-part="made" className="wb-part">
            <h4 className="wb-part-title made">What got made</h4>
            <div className="wb-results">
              {data!.results.map((result) => (
                <button key={`${result.label}\u0000${result.url}`} type="button" className="wb-result" title={result.url} onClick={() => api.openResult(bot.id, result.url)}>
                  <span className="wb-result-label">{result.label}</span><Icon name="arrowUpRight" size={12} />
                </button>
              ))}
            </div>
          </section>
        )}
        {has.decided && (
          <section data-part="decided" className="wb-part">
            <h4 className="wb-part-title">Calls I made myself</h4>
            {data!.decided.map((line, index) => <span key={index} className="wb-line">{line}</span>)}
          </section>
        )}
        {has.next && (
          <section data-part="next" className="wb-part">
            <h4 className="wb-part-title">Next</h4>
            {next.map((line, index) => <span key={index} className="wb-line">{index + 1}. {line}</span>)}
          </section>
        )}
      </div>
    </article>
  );
}

/** The board's input: a message to the main bot ("how is everyone doing?"); its reply shows in the main bot's corner. */
function WhiteboardComposer({ api }: { api: BoardApi }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    void api.send(message).then(() => setText(""), api.onError).finally(() => setSending(false));
  };
  return (
    <form className="wb-composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
      <div className="wb-composer-box">
        <textarea className="wb-composer-input" rows={1} value={text} placeholder="Ask how everyone's doing…" aria-label="Message to the main bot"
          onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !(event.nativeEvent ?? event).isComposing) { event.preventDefault(); send(); } }} />
        <button type="submit" className="wb-composer-send" aria-label="Send" disabled={!text.trim() || sending}>↑</button>
      </div>
    </form>
  );
}
