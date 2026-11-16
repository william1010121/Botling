// The shell's fallback screen (M7-07c; plan-change §4.3 check 5, C1: "a broken chat plugin must not brick the app").
//
// Drawn in the chat column's place (shell/regions.tsx `RegionSlot`) while `botling.chat` is away: refused by the FE-build manifest, failed
// in `activate`, or unloaded. It is the shell's own code, so it needs nothing from the plugin:
//   - the bot list: every bot the store holds. They come from the attached server's snapshot and from the peers' `srv:` summary rows
//     (the adapter turns those into `BotView`s, main-v3/renderer-adapter.ts), so the list is the same one the rail has;
//   - the opened bot's last lines (read only, the newest FALLBACK_LINES of what the store holds, a pending line included);
//   - one plain text box that sends `chat.send`. The request goes the way every send does: into the durable outbox through the
//     renderer's client (the adapter answers once the item is durable and draws a pending line, §13.4). The fallback keeps no copy and
//     no queue of its own, so a message it sent shows in the chat plugin, by slot, when that loads later.
//
// What used to sit inside the chat column and went with it (the tab switch, so Storage stays reachable; the alert lines; the worker ask
// bar; the bottom panels; the error bar) is handed in by the page as `parts` and drawn here, so none of it is lost with the plugin.
// It is a read and a send, not the chat: no attachments, no cards, no markdown, no streaming. Text from a peer or a row is drawn as
// React text (never markup) with control characters escaped and long lines cut.
//
// Pure React over two ports (`FallbackSource`): the page (the web build) hands in its client and store the same way the desktop does.
import { useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { MESSAGE_TEXT_LIMIT, type BotView, type MessageView } from "../../contract";
import { RequestFailed, type Client } from "../client";
import type { WorkspaceStore } from "../store";
import { CHAT_UNAVAILABLE } from "../chat-names";

/** How many of the opened bot's newest lines the fallback draws. */
export const FALLBACK_LINES = 30;
/** The longest text the box sends (the contract's `chat.send` limit). */
export const FALLBACK_TEXT_LIMIT = MESSAGE_TEXT_LIMIT;
/** A line is cut here when drawn (the full text stays in the store). */
const LINE_CHARS = 4_000;
const NAME_CHARS = 80;

/** What the fallback reads and asks: the renderer's client (sends) and store (bots, lines, `select`). */
export interface FallbackSource {
  client: Pick<Client, "request">;
  store: Pick<WorkspaceStore, "getView" | "subscribe" | "select">;
}

/** The chrome the page had inside the chat column, as the page draws it now (undefined: nothing to draw). */
export interface FallbackParts {
  /** The header's trailing part (where the bottom panels' toggle button is placed). */
  header?: ReactNode;
  /** The Chat / Storage switch. */
  bar?: ReactNode;
  /** The core-swap line, the bot's problem line and the rounds bar. */
  alerts?: ReactNode;
  /** The Storage page (or a plugin's tab page): drawn in place of the lines and the box. */
  page?: ReactNode;
  /** The worker ask bar. */
  worker?: ReactNode;
  /** The bottom panels. */
  bottom?: ReactNode;
  /** The page's error bar. */
  error?: ReactNode;
}

export interface FallbackProps { source?: FallbackSource; parts?: FallbackParts }

/** One short line of outside text: the first line, control characters escaped, at most `max` characters. */
function oneLine(text: string, max: number): string {
  const first = text.split(/\r\n|[\n\r\u2028\u2029]/).find((piece) => piece.length > 0) ?? "";
  const cleaned = first.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}
/** A message's text for drawing: newlines kept, other control characters escaped, long text cut. */
function drawn(text: string): string {
  const cleaned = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return cleaned.length > LINE_CHARS ? `${cleaned.slice(0, LINE_CHARS)}…` : cleaned;
}

function statusOf(bot: BotView): string {
  if (bot.problem) return "problem";
  if (bot.working) return "working";
  return bot.unread > 0 ? `${bot.unread} new` : "";
}

function failureText(error: unknown): string {
  const message = error instanceof RequestFailed ? error.error.message : error instanceof Error ? error.message : String(error);
  return oneLine(message, 300) || "Not sent.";
}

export function Fallback({ source, parts = {} }: FallbackProps) {
  return (
    <section className="chat-pane chat-unavailable chat-fallback">
      <div className="chat-column fallback-column">
        <header className="chat-header drag">
          <span className="chat-title">Botling</span>
          {parts.header}
        </header>
        <div className="banner" role="status">{CHAT_UNAVAILABLE}</div>
        {parts.bar}
        {parts.alerts}
        {source && <FallbackBody source={source} page={parts.page} />}
        {!source && parts.page}
        {parts.worker}
        {parts.bottom}
      </div>
      {parts.error}
    </section>
  );
}

function FallbackBody({ source, page }: { source: FallbackSource; page: ReactNode }) {
  const { client, store } = source;
  const view = useSyncExternalStore(store.subscribe, store.getView);
  const open = view.chat?.botId ?? null;
  const lines: MessageView[] = open ? view.chat!.messages.slice(-FALLBACK_LINES) : [];
  return (
    <div className="fallback-body">
      <nav className="fallback-bots" aria-label="Bots">
        <ul>
          {view.bots.map((bot) => (
            <li key={bot.id}>
              <button type="button" aria-pressed={bot.id === open} data-bot={bot.id} onClick={() => { if (bot.id !== open) void store.select(bot.id).catch(() => undefined); }}>
                <span className="fallback-bot-name">{oneLine(bot.name, NAME_CHARS) || "Bot"}</span>
                <span className="fallback-bot-status">{statusOf(bot)}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="fallback-chat">
        {page ?? (
          <>
            <ol className="fallback-lines" aria-label="Last messages">
              {lines.map((line) => <li key={line.id} data-role={line.role} data-queued={line.queued ? "1" : undefined}>{drawn(line.text)}</li>)}
            </ol>
            <SendBox client={client} botId={open} />
          </>
        )}
      </div>
    </div>
  );
}

/** The plain text box: one send at a time (a double press asks once), the text kept when a send fails. */
function SendBox({ client, botId }: { client: Pick<Client, "request">; botId: string | null }) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const send = async () => {
    if (sending.current) return;
    const body = text;
    if (!body.trim()) return;
    if (!botId) { setProblem("Open a bot first."); return; }
    if (body.length > FALLBACK_TEXT_LIMIT) { setProblem(`Too long: at most ${FALLBACK_TEXT_LIMIT} characters.`); return; }
    sending.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await client.request({ type: "chat.send", botId, text: body });
      setText((now) => (now === body ? "" : now));
    } catch (error) {
      setProblem(failureText(error));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void send(); };
  const key = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };
  return (
    <form className="fallback-input" onSubmit={submit}>
      <textarea value={text} rows={2} aria-label="Message" placeholder="Message" onChange={(event) => setText(event.target.value)} onKeyDown={key} />
      <button type="submit" disabled={busy}>Send</button>
      {problem && <div className="fallback-problem" role="alert">{problem}</div>}
    </form>
  );
}
