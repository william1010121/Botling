// The main bot's whiteboard: every bot as a card, grouped (a group chat's members together, then the
// projects, then the bots of their own). A card shows the bot's one short line (the first sentence of
// its memory.md's first "Current status" line, else of its first "In progress" line, else what its
// running task does now, cut to one line), how many things wait on you, a ring of its tasks done and a bar of its tasks by state.
// Pressed, the card grows in place into the bot's report, read by scrolling: Summary, Your call,
// Results, Progress (tasks finished per day), What I did, My calls ("Decided"), Next. Everything is
// what the bots keep themselves (memory.md, task cards, links handed over in their chats); a part
// with nothing in it is left out. A bot may give its card a picture of its own (<whiteboard>): one
// of its components, drawn as a 1×1 or 2×1 Board tile in place of the ring, in the same sandboxed
// component frame as the chat's (Web/src's `componentPage`, served by main as `card.page`). That
// module is loaded only when a picture is drawn: it also listens for the chat page's own component
// frames (`iframe.component-frame`, of which this page has none), so it is inert here.
// A bot gone quiet (nothing waiting on you, nothing at work, no line or task change for
// INACTIVE_AFTER_MS) is left off the board unless pinned; a quiet toggle at the end shows them.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { type BotView, type ComponentInfoView, type MessageView, type ResultView, type TaskView, type WaitingItemView, type WaitingView, type WhiteboardBotView, type WhiteboardPictureView, type WhiteboardView } from "../contract";
import type { Client } from "./client";
import { faceURL } from "./avatars";
import { Icon } from "./icons";
import { activeTasks, finishedTasks } from "./RightPanel";
import { dictionaries, type Lang } from "../../../Web/src/i18n";
import { en, type Key } from "../../../Web/src/locales/en";

/** The board's own words in `lang` (the chat page's dictionaries; English for anything missing). */
function say(lang: Lang | null | undefined, key: Key, values: Record<string, string | number> = {}): string {
  const word = dictionaries[lang ?? "en"]?.[key] ?? en[key];
  const text = typeof word === "string" ? word : values.n === 1 ? word[0] : word[1];
  return text.replace(/\{(\w+)\}/g, (mark, name: string) => (name in values ? String(values[name]) : mark));
}

type Look = "original" | "cute";

/** The main view of the main bot: the whiteboard unless you last picked Chat or Board (kept for the next start). */
export const CHOICE_KEY = "botling.mainWhiteboard";
export function useWhiteboardChoice(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(CHOICE_KEY) !== "0"; } catch { return true; } });
  const choose = useCallback((next: boolean) => {
    setOn(next);
    try { localStorage.setItem(CHOICE_KEY, next ? "1" : "0"); } catch { /* no storage: this session only */ }
  }, []);
  return [on, choose];
}

export interface WhiteboardSection { id: string; title: string; bots: BotView[]; group: BotView | null }

/**
 * The board's groups: each group chat with its members (a bot in two groups shows in the first),
 * then the projects and the bots of their own in no group. The main bot is not a card; empty
 * sections are left out.
 */
export function whiteboardSections(bots: BotView[]): WhiteboardSection[] {
  const placed = new Set<string>();
  const out: WhiteboardSection[] = [];
  const cardable = (bot: BotView | undefined): bot is BotView => !!bot && bot.role !== "main" && bot.role !== "group";
  for (const group of bots.filter((bot) => bot.role === "group")) {
    const members = (group.members ?? []).map((id) => bots.find((bot) => bot.id === id)).filter(cardable).filter((bot) => !placed.has(bot.id));
    for (const member of members) placed.add(member.id);
    if (members.length) out.push({ id: group.id, title: group.name, bots: members, group });
  }
  const rest = bots.filter((bot) => cardable(bot) && !placed.has(bot.id));
  const projects = rest.filter((bot) => bot.role === "manager");
  const own = rest.filter((bot) => bot.role === "bot");
  if (projects.length) out.push({ id: "projects", title: "Projects", bots: projects, group: null });
  if (own.length) out.push({ id: "bots", title: "Bots", bots: own, group: null });
  return out;
}

/** A bot with no line said and no task changed for this long (and nothing waiting or at work) is left off the board. */
export const INACTIVE_AFTER_MS = 48 * 3_600_000;

/** When the bot last did something: its chat's newest line or its newest task change (ms; null: never). */
export function lastActive(bot: BotView, data: WhiteboardBotView | undefined): number | null {
  const times = [bot.lastActivity, ...(data?.tasks ?? []).map((task) => task.updatedAt)].map((iso) => (iso ? Date.parse(iso) : NaN)).filter((at) => !Number.isNaN(at));
  return times.length ? Math.max(...times) : null;
}

/** Gone quiet: not pinned, nothing waiting on you, nothing at work, and nothing done for INACTIVE_AFTER_MS. */
export function isInactive(bot: BotView, data: WhiteboardBotView | undefined, waiting: WaitingView, now: number, pinned: ReadonlySet<string>): boolean {
  if (pinned.has(bot.id) || waitingCount(bot, waiting, data) > 0) return false;
  if (bot.working || bot.subagents > 0 || bot.guest || (data?.tasks ?? []).some((task) => task.state === "running" && task.atWork)) return false;
  const at = lastActive(bot, data);
  return at === null || now - at > INACTIVE_AFTER_MS;
}

/** The sections with the hidden bots taken out (a section left empty goes), and how many were hidden. */
export function shownSections(sections: WhiteboardSection[], hide: (bot: BotView) => boolean): { sections: WhiteboardSection[]; hidden: number } {
  let hidden = 0;
  const out: WhiteboardSection[] = [];
  for (const section of sections) {
    const bots = section.bots.filter((bot) => !hide(bot));
    hidden += section.bots.length - bots.length;
    if (bots.length) out.push({ ...section, bots });
  }
  return { sections: out, hidden };
}

/** What waits on you from one bot: its open questions or its memory's "Waiting on you" (as the right panel lists them). */
export const waitingFor = (bot: BotView, waiting: WaitingView): WaitingItemView[] => waiting.items.filter((item) => item.botId === bot.id);

/** How many things wait on you from the bot: those questions, its tasks waiting on you, its tool approvals. */
export function waitingCount(bot: BotView, waiting: WaitingView, data: WhiteboardBotView | undefined): number {
  return waitingFor(bot, waiting).length + (data?.tasks.filter((task) => task.state === "waiting" && task.name.trim()).length ?? 0) + bot.approvals;
}

/** How wide a card's line may be, in half-width columns (a CJK character is two): one short sentence, as the approved design's cards. */
export const CARD_LINE_WIDTH = 44;

const wideChar = (char: string) => (char.codePointAt(0) ?? 0) >= 0x2e80;
/** A text's width in half-width columns (a CJK or full-width character counts two). */
export const lineWidth = (text: string) => [...text].reduce((sum, char) => sum + (wideChar(char) ? 2 : 1), 0);

/**
 * One short line from what a bot wrote: markdown marks taken off, its first sentence only, cut to
 * `width` columns with "…". A memory paragraph never goes on a card whole; the report has it all.
 */
export function shortLine(text: string | null | undefined, width = CARD_LINE_WIDTH): string | null {
  const plain = (text ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__|`/g, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim();
  if (!plain) return null;
  const end = plain.search(/[。！？]|[.!?](?=\s|$)/);
  const sentence = end >= 0 ? plain.slice(0, end + 1).trim() : plain;
  if (lineWidth(sentence) <= width) return sentence;
  let out = "";
  let used = 0;
  for (const char of sentence) {
    const step = wideChar(char) ? 2 : 1;
    if (used + step > width - 1) break;
    out += char;
    used += step;
  }
  return `${out.trimEnd().replace(/[，、,;；:：]$/, "")}…`;
}

/**
 * The card's one short line: the first sentence of "Current status", else of "In progress", else
 * what the bot or its running task does now, else the bot's job (each cut to CARD_LINE_WIDTH).
 */
export function highlight(bot: BotView, data: WhiteboardBotView | undefined, waiting: WaitingView): string | null {
  const task = data ? activeTasks(named(data.tasks)).find((candidate) => candidate.state === "running" && candidate.now?.trim()) : undefined;
  for (const text of [data?.currentStatus[0], data?.inProgress[0], waiting.doing[bot.id], task?.now, bot.job]) {
    const line = shortLine(text);
    if (line) return line;
  }
  return null;
}

/** The picture to draw on the card: one with data to show and its component at hand; else none (the ring). */
export function drawnPicture(data: WhiteboardBotView | undefined, components: Record<string, ComponentInfoView>): WhiteboardPictureView | null {
  const picture = data?.picture;
  if (!picture || !components[picture.name]) return null;
  if (picture.status === "approve" || picture.status === "failed" || picture.status === "empty") return null;
  return picture.data === "null" ? null : picture;
}

/** At most this many pictures are drawn at once (each is a frame of its own); the rest show their ring. */
export const MOST_PICTURES = 12;

const named = (tasks: TaskView[]) => tasks.filter((task) => task.name.trim().length > 0);

/** Tasks by state for the bar: waiting on you, under way, finished. */
export function taskCounts(tasks: TaskView[]): { waiting: number; active: number; done: number; total: number } {
  const shown = named(tasks);
  const waiting = shown.filter((task) => task.state === "waiting").length;
  const active = shown.filter((task) => task.state === "running" || task.state === "pending").length;
  const done = shown.filter((task) => task.state === "done" || task.state === "stopped").length;
  return { waiting, active, done, total: waiting + active + done };
}

/** Tasks finished on each of the last seven days, oldest first (by the time the card last changed). */
export function doneByDay(tasks: TaskView[], now: number): { day: string; count: number; today: boolean }[] {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, index) => {
    const from = new Date(start); from.setDate(start.getDate() - (6 - index));
    const to = new Date(from); to.setDate(from.getDate() + 1);
    return { from: from.getTime(), to: to.getTime(), day: index === 6 ? "Today" : from.toLocaleDateString("en-US", { month: "short", day: "numeric" }), today: index === 6 };
  });
  return days.map(({ from, to, day, today }) => ({ day, today, count: named(tasks).filter((task) => task.state === "done" && (() => { const at = Date.parse(task.updatedAt); return at >= from && at < to; })()).length }));
}

/** "Next": the memory's "In progress" lines, then what the tasks under way say comes next (no repeats). */
export function nextSteps(data: WhiteboardBotView): string[] {
  const out: string[] = [];
  for (const line of [...data.inProgress, ...activeTasks(named(data.tasks)).map((task) => task.next ?? "")]) {
    const text = line.trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out.slice(0, 10);
}

function shortTime(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.toDateString() === new Date(now - 86_400_000).toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Asks the core for the board's data now and every few seconds while it is shown; an answer like the last one changes nothing. */
function useWhiteboardData(client: Client, refreshMs: number): WhiteboardView | null {
  const [data, setData] = useState<WhiteboardView | null>(null);
  const last = useRef("");
  useEffect(() => {
    let live = true;
    const load = () => {
      void client.request({ type: "whiteboard.view" }).then((view) => {
        const text = JSON.stringify(view);
        if (!live || text === last.current) return;
        last.current = text;
        setData(view);
      }, () => {});
    };
    load();
    const timer = refreshMs > 0 ? setInterval(load, refreshMs) : null;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [client, refreshMs]);
  return data;
}

export interface WhiteboardProps {
  client: Client;
  bots: BotView[];
  waiting: WaitingView;
  /** The component library (for the bots' pictures). */
  components: Record<string, ComponentInfoView>;
  look: Look;
  now: number;
  /** The main bot's chat lines, for its latest reply on the board. */
  mainMessages: MessageView[];
  mainBotId: string;
  statusOf: (bot: BotView) => { key: string; text: string };
  onOpenChat: (botId: string) => void;
  onError: (failure: unknown) => void;
  /** How often the board asks again (ms); 0: only once (tests). */
  refreshMs?: number;
  /** Bots pinned to the top of the left column: always on the board. */
  pinned?: string[];
  /** The app's language, for the board's own words. */
  lang?: Lang | null;
}

export function Whiteboard({ client, bots, waiting, components, look, now, mainMessages, mainBotId, statusOf, onOpenChat, onError, refreshMs = 5_000, pinned, lang }: WhiteboardProps) {
  const data = useWhiteboardData(client, refreshMs);
  const byBot = useMemo(() => new Map((data?.bots ?? []).map((entry) => [entry.botId, entry])), [data]);
  const allSections = useMemo(() => whiteboardSections(bots), [bots]);
  const [showInactive, setShowInactive] = useState(false);
  const pins = useMemo(() => new Set(pinned ?? []), [pinned]);
  // A group chat with its own question to you keeps its members on the board.
  const groupAsks = new Set(waiting.items.filter((item) => item.groupId && item.botId === item.groupId).map((item) => item.groupId!));
  const quiet = shownSections(allSections, (bot) => !allSections.some((section) => section.group && groupAsks.has(section.group.id) && section.bots.includes(bot))
    && isInactive(bot, byBot.get(bot.id), waiting, now, pins));
  const sections = showInactive ? allSections : quiet.sections;
  const [open, setOpen] = useState<{ botId: string; origin: string } | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const cards = sections.flatMap((section) => section.bots);
  const totalTasks = cards.reduce((sum, bot) => sum + taskCounts(byBot.get(bot.id)?.tasks ?? []).total, 0);
  const totalWaiting = cards.reduce((sum, bot) => sum + waitingCount(bot, waiting, byBot.get(bot.id)), 0);
  const openBot = open ? bots.find((bot) => bot.id === open.botId) ?? null : null;
  // The first pictures in the board's order are drawn; past MOST_PICTURES a card keeps its ring.
  const pictured = new Set(cards.filter((bot) => drawnPicture(byBot.get(bot.id), components)).slice(0, MOST_PICTURES).map((bot) => bot.id));

  const press = (bot: BotView, element: HTMLElement) => {
    // The report grows out of the card: its scale starts at the card's place on the canvas.
    const box = canvas.current?.getBoundingClientRect();
    const at = element.getBoundingClientRect();
    const origin = box ? `${Math.round(at.left - box.left + at.width / 2)}px ${Math.round(at.top - box.top + at.height / 2)}px` : "50% 0";
    setOpen({ botId: bot.id, origin });
  };
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);

  return (
    <div className="whiteboard" aria-label="Whiteboard">
      <div className="wb-bar">
        <span className="wb-bar-count">{cards.length} bot{cards.length === 1 ? "" : "s"} · {totalTasks} task{totalTasks === 1 ? "" : "s"}{totalWaiting > 0 ? ` · ${totalWaiting} waiting on you` : ""}</span>
      </div>
      <div className="wb-canvas" ref={canvas}>
        <div className="wb-sections">
          {sections.map((section) => {
            const sectionWaiting = section.bots.reduce((sum, bot) => sum + waitingCount(bot, waiting, byBot.get(bot.id)), 0)
              + (section.group ? waiting.items.filter((item) => item.groupId === section.group!.id && item.botId === section.group!.id).length : 0);
            const sectionTasks = section.bots.reduce((sum, bot) => sum + taskCounts(byBot.get(bot.id)?.tasks ?? []).total, 0);
            const wide = section.bots.reduce((sum, bot) => sum + (waitingCount(bot, waiting, byBot.get(bot.id)) > 0 ? 2 : 1), 0);
            return (
              <section key={section.id} className="wb-section" data-section={section.id} style={{ flexGrow: Math.min(wide, 4), flexBasis: `${Math.min(wide, 4) * 200}px` } as CSSProperties}>
                <h3 className="wb-section-title">
                  {section.group ? <button type="button" className="wb-section-open" onClick={() => onOpenChat(section.group!.id)} title={`Open ${section.title}`}>{section.title}</button> : section.title}
                  <span className="wb-section-meta"> · {sectionTasks} task{sectionTasks === 1 ? "" : "s"}{sectionWaiting > 0 ? ` · ${sectionWaiting} waiting` : ""}</span>
                </h3>
                <div className="wb-grid">
                  {section.bots.map((bot) => (
                    <BotCard key={bot.id} client={client} bot={bot} data={byBot.get(bot.id)} waiting={waiting} look={look} now={now} status={statusOf(bot)}
                      picture={pictured.has(bot.id) ? drawnPicture(byBot.get(bot.id), components) : null} components={components}
                      onPress={(element) => press(bot, element)} />
                  ))}
                </div>
              </section>
            );
          })}
          <MainSummary bots={bots} waiting={waiting} data={byBot} look={look} messages={mainMessages} mainBotId={mainBotId} sections={sections} />
          {allSections.length === 0 && <div className="wb-empty">No bots yet. Add a project or a bot of your own, and its card shows here.</div>}
          {quiet.hidden > 0 && (
            <div className="wb-inactive">
              <button type="button" className="wb-inactive-toggle" aria-expanded={showInactive} onClick={() => setShowInactive((on) => !on)}>
                {showInactive ? say(lang, "whiteboard.hideInactive") : say(lang, "whiteboard.showInactive", { n: quiet.hidden })}
              </button>
            </div>
          )}
        </div>
        {open && openBot && (
          <div className="wb-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) setOpen(null); }}>
            <Report client={client} components={components} bot={openBot} data={byBot.get(openBot.id)} waiting={waiting} look={look} now={now} origin={open.origin} status={statusOf(openBot)}
              onAllow={(picture) => void client.request({ type: "whiteboard.allow", botId: openBot.id, command: picture.command!, folder: picture.folder! }).catch(onError)}
              onClose={() => setOpen(null)} onOpenChat={(id) => { setOpen(null); onOpenChat(id); }}
              onOpenResult={(result) => void client.request({ type: "result.open", botId: openBot.id, url: result.url }).catch(onError)} />
          </div>
        )}
      </div>
      <WhiteboardComposer client={client} mainBotId={mainBotId} onError={onError} />
    </div>
  );
}

/** A ring of the bot's tasks done out of all of them. */
function TaskRing({ done, total }: { done: number; total: number }) {
  const length = 2 * Math.PI * 20;
  const part = total ? (done / total) * length : 0;
  return (
    <svg className="wb-ring" width="52" height="52" viewBox="0 0 52 52" role="img" aria-label={`${done} of ${total} tasks done`}>
      <circle cx="26" cy="26" r="20" fill="none" stroke="var(--chip)" strokeWidth="6" />
      {part > 0 && <circle cx="26" cy="26" r="20" fill="none" stroke="var(--green)" strokeWidth="6" strokeDasharray={`${part} ${length}`} strokeLinecap="round" transform="rotate(-90 26 26)" />}
      <text x="26" y="30" textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--text)">{done}/{total}</text>
    </svg>
  );
}

/** The bar along a card's foot: its tasks waiting on you, under way and finished. */
function StateBar({ counts }: { counts: ReturnType<typeof taskCounts> }) {
  const part = (count: number) => `${counts.total ? (count / counts.total) * 100 : 0}%`;
  return (
    <span className="wb-statebar" aria-hidden="true">
      {counts.waiting > 0 && <span className="waiting" style={{ width: part(counts.waiting) }} />}
      {counts.active > 0 && <span className="active" style={{ width: part(counts.active) }} />}
      {counts.done > 0 && <span className="done" style={{ width: part(counts.done) }} />}
    </span>
  );
}

/**
 * A bot's picture: its component as a Board tile (`componentPage`, surface "board", filling the
 * frame, read only), in a sandboxed frame main serves the page to (`card.page`). The chat page's
 * component broker is not here, so what the component posts (answers, saves) goes nowhere.
 */
function PictureFrame({ client, picture, info, size, title }: { client: Client; picture: WhiteboardPictureView; info: ComponentInfoView; size: string; title: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const images = JSON.stringify(picture.images ?? {});
  useEffect(() => {
    let live = true;
    void import("../../../Web/src/components").then(({ componentPage }) => {
      const page = componentPage(info.template, picture.data, JSON.parse(images) as Record<string, string>, size as `${number}x${number}`, "board", true, false);
      return client.request({ type: "card.page", html: page });
    }).then((result) => { if (live) setUrl(result.url); }, () => {});
    return () => { live = false; };
  }, [client, info.template, picture.data, images, size]);
  return (
    <span className={`wb-picture wb-picture-${size}`} aria-hidden={url ? undefined : true}>
      {url && <iframe className="wb-picture-frame" sandbox="allow-scripts" src={url} title={title} tabIndex={-1} />}
    </span>
  );
}

function BotCard({ client, bot, data, waiting, look, now, status, picture, components, onPress }: {
  client: Client; bot: BotView; data: WhiteboardBotView | undefined; waiting: WaitingView; look: Look; now: number; status: { key: string; text: string };
  picture: WhiteboardPictureView | null; components: Record<string, ComponentInfoView>; onPress: (element: HTMLElement) => void;
}) {
  const count = waitingCount(bot, waiting, data);
  const counts = taskCounts(data?.tasks ?? []);
  const line = highlight(bot, data, waiting);
  const when = shortTime(bot.lastActivity, now);
  const asleep = bot.phase === "asleep" && !bot.working;
  return (
    <button type="button" className={`wb-card${count > 0 ? " waiting" : ""}${picture?.size === "2x1" ? " wide" : ""}`} data-bot={bot.id} onClick={(event) => onPress(event.currentTarget)}
      aria-label={[`${bot.name}'s report`, status.text, count ? `${count} waiting on you` : null, line].filter(Boolean).join(", ")}>
      <span className="wb-card-head">
        <img className="wb-face" src={faceURL(bot, look, { asleep, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
        <span className="wb-card-name">{bot.name}</span>
        {count > 0 && <span className="wb-pill">{count} waiting</span>}
        {when && <span className="wb-card-time">{when}</span>}
      </span>
      <span className={`wb-card-body${picture?.size === "2x1" ? " stacked" : ""}`}>
        {picture ? <PictureFrame client={client} picture={picture} info={components[picture.name]!} size={picture.size} title={`${bot.name}'s picture`} />
          : counts.total > 0 && <TaskRing done={counts.done} total={counts.total} />}
        <span className="wb-card-text">
          {line ? <span className="wb-highlight">{line}</span> : <span className="wb-highlight none">Nothing written yet</span>}
        </span>
      </span>
      <span className="wb-card-foot">
        <span className="wb-status"><span className="now-dot" data-status={status.key} aria-hidden="true" />{status.text}</span>
        {counts.total > 0 && <span className="wb-foot-count">{counts.active > 0 ? `${counts.active} under way` : `${counts.done} done`}</span>}
      </span>
      {counts.total > 0 && <StateBar counts={counts} />}
    </button>
  );
}

/** The main bot's corner: who waits on you, and its latest reply. */
function MainSummary({ bots, waiting, data, look, messages, mainBotId, sections }: {
  bots: BotView[]; waiting: WaitingView; data: Map<string, WhiteboardBotView>; look: Look; messages: MessageView[]; mainBotId: string; sections: WhiteboardSection[];
}) {
  const main = bots.find((bot) => bot.id === mainBotId);
  const reply = messages.findLast((message) => message.role === "bot" && message.text.trim());
  const from = sections.flatMap((section) => section.bots).map((bot) => ({ bot, count: waitingCount(bot, waiting, data.get(bot.id)) })).filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);
  const total = from.reduce((sum, entry) => sum + entry.count, 0);
  if (!main || (!reply && total === 0)) return null;
  return (
    <section className="wb-main" aria-label="Main bot summary">
      <span className="wb-main-head"><img className="wb-face" src={faceURL(main, look, {})} alt="" />{main.name}{reply ? " · latest reply" : ""}</span>
      {total > 0 && <span className="wb-main-line">{total} waiting on you: {from.map((entry) => `${entry.count} from ${entry.bot.name}`).join(", ")}.</span>}
      {reply && <span className="wb-main-reply">{shortLine(reply.text, 2 * CARD_LINE_WIDTH)}</span>}
    </section>
  );
}

const SECTIONS = [["sum", "Summary"], ["ask", "Your call"], ["made", "Results"], ["trend", "Progress"], ["log", "What I did"], ["decided", "My calls"], ["next", "Next"]] as const;
type ReportSection = (typeof SECTIONS)[number][0];

function Report({ client, components, bot, data, waiting, look, now, origin, status, onClose, onOpenChat, onOpenResult, onAllow }: {
  client: Client; components: Record<string, ComponentInfoView>;
  bot: BotView; data: WhiteboardBotView | undefined; waiting: WaitingView; look: Look; now: number; origin: string; status: { key: string; text: string };
  onClose: () => void; onOpenChat: (botId: string) => void; onOpenResult: (result: ResultView) => void; onAllow: (picture: WhiteboardPictureView) => void;
}) {
  const picture = drawnPicture(data, components);
  // Its picture's command waits for your OK: what would run where, and Allow.
  const asking = data?.picture?.status === "approve" && data.picture.command && data.picture.folder ? data.picture : null;
  const body = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const tasks = named(data?.tasks ?? []);
  const counts = taskCounts(tasks);
  const asks = waitingFor(bot, waiting);
  const waitingTasks = tasks.filter((task) => task.state === "waiting");
  const done = finishedTasks(tasks, 12);
  const days = doneByDay(tasks, now);
  const peak = Math.max(1, ...days.map((day) => day.count));
  const next = data ? nextSteps(data) : [];
  const status0 = data?.currentStatus ?? [];
  const has: Record<ReportSection, boolean> = {
    sum: status0.length > 0 || counts.total > 0 || asks.length > 0 || !!picture || !!asking,
    ask: asks.length + waitingTasks.length + bot.approvals > 0,
    made: (data?.results.length ?? 0) > 0,
    trend: days.some((day) => day.count > 0),
    log: done.length > 0,
    decided: (data?.decided.length ?? 0) > 0,
    next: next.length > 0,
  };
  const waitingTotal = asks.length + waitingTasks.length + bot.approvals;
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
          <img className="wb-report-face" src={faceURL(bot, look, { asleep: bot.phase === "asleep" && !bot.working, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
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
        {shown.length === 0 && <p className="wb-report-empty">{bot.name} has not written a status, tasks or results yet.</p>}
        {has.sum && (
          <section data-part="sum" className="wb-part">
            {picture && <PictureFrame client={client} picture={picture} info={components[picture.name]!} size="2x2" title={`${bot.name}'s picture`} />}
            {asking && (
              <div className="wb-picture-ask">
                <span className="wb-ask-text">Its picture comes from <code>{asking.command}</code>, run in {asking.folder}. It runs once you allow it.</span>
                <button type="button" className="wb-ask-open" onClick={() => onAllow(asking)}>Allow and run</button>
              </div>
            )}
            {status0.map((line, index) => <p key={index} className="wb-sum-line">{line}</p>)}
            <div className="wb-stats">
              <span className="wb-stat"><span className="wb-stat-n done">{counts.done}</span><span className="wb-stat-l">done</span></span>
              <span className="wb-stat"><span className="wb-stat-n active">{counts.active}</span><span className="wb-stat-l">under way</span></span>
              <span className="wb-stat"><span className="wb-stat-n waiting">{waitingTotal}</span><span className="wb-stat-l">waiting on you</span></span>
            </div>
          </section>
        )}
        {has.ask && (
          <section data-part="ask" className="wb-part">
            <h4 className="wb-part-title ask">Your call</h4>
            {asks.map((item) => (
              <div key={`${item.botId}-${item.text}`} className="wb-ask">
                <span className="wb-ask-text">{item.text}</span>
                <button type="button" className="wb-ask-open" onClick={() => onOpenChat(item.groupId ?? item.botId)}>Answer in chat</button>
              </div>
            ))}
            {waitingTasks.map((task) => (
              <div key={task.id} className="wb-ask" data-task={task.id}>
                <span className="wb-ask-text"><b>{task.name}</b>{task.blocked ?? task.now ? ` · ${task.blocked ?? task.now}` : ""}</span>
                <button type="button" className="wb-ask-open" onClick={() => onOpenChat(bot.id)}>Answer in chat</button>
              </div>
            ))}
            {bot.approvals > 0 && (
              <div className="wb-ask">
                <span className="wb-ask-text">{bot.approvals} tool approval{bot.approvals === 1 ? "" : "s"} waiting</span>
                <button type="button" className="wb-ask-open" onClick={() => onOpenChat(bot.id)}>Answer in chat</button>
              </div>
            )}
          </section>
        )}
        {has.made && (
          <section data-part="made" className="wb-part">
            <h4 className="wb-part-title made">What got made</h4>
            <div className="wb-results">
              {data!.results.map((result) => (
                <button key={`${result.label}\u0000${result.url}`} type="button" className="wb-result" title={result.url} onClick={() => onOpenResult(result)}>
                  <span className="wb-result-label">{result.label}</span><Icon name="arrowUpRight" size={12} />
                </button>
              ))}
            </div>
          </section>
        )}
        {has.trend && (
          <section data-part="trend" className="wb-part">
            <h4 className="wb-part-title">Tasks finished this week</h4>
            <div className="wb-chart">
              <svg width="100%" height="96" viewBox="0 0 700 96" preserveAspectRatio="none" role="img"
                aria-label={`Tasks finished per day: ${days.map((day) => `${day.day} ${day.count}`).join(", ")}`}>
                {days.map((day, index) => {
                  const height = day.count ? Math.max(6, (day.count / peak) * 86) : 2;
                  return <rect key={day.day} x={index * 100 + 15} y={92 - height} width="70" height={height} rx="4" className={day.today ? "today" : day.count ? "bar" : "empty"} />;
                })}
              </svg>
              <div className="wb-chart-days">{days.map((day) => <span key={day.day}>{day.day}{day.count ? ` · ${day.count}` : ""}</span>)}</div>
            </div>
          </section>
        )}
        {has.log && (
          <section data-part="log" className="wb-part">
            <h4 className="wb-part-title">What I did (newest first)</h4>
            {done.map((task) => (
              <span key={task.id} className="wb-log" data-task={task.id}>
                <span className="wb-log-when">{shortTime(task.updatedAt, now)}</span>
                <span className="wb-log-text">{task.state === "stopped" ? `${task.name} (stopped)` : task.name}</span>
              </span>
            ))}
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
function WhiteboardComposer({ client, mainBotId, onError }: { client: Client; mainBotId: string; onError: (failure: unknown) => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    void client.request({ type: "chat.send", botId: mainBotId, text: message }).then(() => setText(""), onError).finally(() => setSending(false));
  };
  return (
    <form className="wb-composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
      <div className="wb-composer-box">
        <textarea className="wb-composer-input" rows={1} value={text} placeholder="Ask how everyone's doing…" aria-label="Message to the main bot"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
        <button type="submit" className="wb-composer-send" aria-label="Send" disabled={!text.trim() || sending}>↑</button>
      </div>
    </form>
  );
}
