// Botling Web's stand-in for the desktop preload (`window.botling`, src/preload/preload.ts): the same
// envelope bridge the renderer's Client speaks, carried over the mobile bridge's HTTPS command route
// instead of Electron IPC. The renderer (src/renderer) runs unchanged on top of it.
//
// Only what the bridge already allows goes to the server: chat.snapshot, chat.send, chat.choose and
// chat.answer (the bridge and the core check them again). A few shell-only commands are answered
// here without the server: per-viewer layout settings (kept in this browser), `chat.read` (unread
// stays the desktop's) and `link.open` for http(s) links (a new tab). Everything else the desktop
// shell can ask for is refused here as `forbidden`, so the renderer shows its usual failure.
//
// The bridge has no event stream, so `poll()` re-reads the snapshot and reports whether it changed
// (epoch or seq); the caller then lets the store resync, which is served from that primed read.
import { CancelEnvelope, RequestEnvelope, errorResponse, okResponse, type Command, type ResponseEnvelope, type ResultOf } from '../src/contract';
import type { Bridge } from '../src/renderer/client';
import { MobileError, type MobileCommand } from './transport';

export const REMOTE_COMMANDS: ReadonlySet<string> = new Set(['chat.snapshot', 'chat.send', 'chat.choose', 'chat.answer']);
/** Layout settings this browser keeps for itself (the desktop keeps its own). */
export const LOCAL_SETTINGS = ['rightPanelCollapsed', 'railCollapsed', 'pinnedBots', 'messageColumnWidth'] as const;
type LocalKey = typeof LOCAL_SETTINGS[number];
export const SESSION_ENDED = 'The session ended. Sign in again.';
export const STORAGE_KEY = 'botling-web-layout';
const PRIMED_FOR_MS = 3_000;

type Snapshot = ResultOf<'chat.snapshot'>;
export interface CommandTransport { request(cmd: MobileCommand): Promise<unknown> }
export interface WebBridgeOptions {
  transport: CommandTransport;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  openURL?: (url: string) => void;
  /** The session ended or expired: the page goes back to Sign in. */
  onAuthLost?: (error: MobileError) => void;
  /** A message was sent or a question answered: read the chat again soon. */
  onMutated?: () => void;
  /** A layout setting changed here: show it (the caller resyncs the store). */
  onLocalChange?: () => void;
  now?: () => number;
}

export class WebBridge implements Bridge {
  readonly protocol = 2;
  private listeners = new Set<(message: unknown) => void>();
  private cancelled = new Set<string>();
  /** Requests posted and not answered yet: closing rejects them, so nothing waits forever. */
  private pending = new Set<string>();
  private primed: { botId: string | undefined; at: number; snapshot: Snapshot } | null = null;
  private last: { botId: string | undefined; snapshot: Snapshot } | null = null;
  private local: Partial<Record<LocalKey, unknown>>;
  private ended = false;

  constructor(private options: WebBridgeOptions) {
    this.local = readLocal(options.storage);
  }

  post(envelope: unknown): void {
    if (this.ended) return;
    const cancel = CancelEnvelope.safeParse(envelope);
    if (cancel.success) {
      // The HTTPS request cannot be withdrawn; its answer is dropped and the caller hears "cancelled".
      this.cancelled.add(cancel.data.cancel);
      this.pending.delete(cancel.data.cancel);
      this.emit(errorResponse(cancel.data.cancel, { code: 'cancelled', message: 'The request was cancelled.' }));
      return;
    }
    const request = RequestEnvelope.safeParse(envelope);
    if (!request.success) return;
    this.pending.add(request.data.id);
    void this.handle(request.data.id, request.data.cmd).then(({ response, ended }) => {
      // A session found over ends everything at once: the page goes back to Sign in and no answer
      // (not even this one) reaches the renderer that is being taken down.
      // (This request is still pending then: closing rejects it with the others.) A late answer after
      // closing, success or not, is dropped.
      if (ended) { this.ended_(ended); return; }
      if (this.ended || !this.pending.delete(response.id)) return;
      if (!this.cancelled.delete(response.id)) this.emit(response);
    });
  }

  subscribe(listener: (message: unknown) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('subscribe takes a function');
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Closed: signed out or the session ended. Nothing kept is served again and nothing more is sent. */
  get closed() { return this.ended; }
  close() {
    if (this.ended) return;
    this.ended = true;
    this.primed = null; this.last = null;
    // Settle everything still waiting (the page's first read included), then hear nothing more.
    const waiting = [...this.pending];
    this.pending.clear(); this.cancelled.clear();
    for (const id of waiting) this.emit(errorResponse(id, { code: 'core_unavailable', message: SESSION_ENDED }));
    this.listeners.clear();
  }

  /** A 401, or a refusal before the bridge looked at the request: the session is over. */
  private ended_(error: unknown) {
    if (!(error instanceof MobileError) || !(error.auth || error.revoked) || this.ended) return;
    this.close();
    this.options.onAuthLost?.(error);
  }

  /** Reads the chat on screen again; true when anything changed since the store last saw it. */
  async poll(botId: string | undefined): Promise<boolean> {
    if (this.ended) return false;
    let snapshot: Snapshot;
    try { snapshot = await this.options.transport.request({ type: 'chat.snapshot', ...(botId ? { botId } : {}) }) as Snapshot; }
    catch (error) { this.ended_(error); throw error; }
    if (this.ended) return false;
    const seen = this.last;
    this.primed = { botId, at: this.now(), snapshot };
    return !seen || seen.botId !== snapshot.chat?.botId || seen.snapshot.epoch !== snapshot.epoch || seen.snapshot.seq !== snapshot.seq;
  }

  /** The settings the renderer sees: the server's display settings with this browser's layout on top. */
  private overlay(snapshot: Snapshot): Snapshot {
    const settings = snapshot.settings ? { ...snapshot.settings } : undefined;
    if (settings) for (const key of LOCAL_SETTINGS) if (key in this.local) (settings as Record<string, unknown>)[key] = this.local[key];
    return { ...snapshot, ...(settings ? { settings } : {}) };
  }

  private async handle(id: string, cmd: Command): Promise<{ response: ResponseEnvelope; ended?: MobileError }> {
    const answer = (response: ResponseEnvelope) => ({ response });
    try {
      if (cmd.type === 'chat.snapshot') {
        const primed = this.primed;
        this.primed = null;
        // A read without a bot is the main bot's (the store's first): any primed read of the chat it showed serves it.
        const matches = primed && (primed.botId === cmd.botId || (cmd.botId === undefined && primed.snapshot.chat?.botId === this.last?.botId));
        const fresh = primed && matches && this.now() - primed.at < PRIMED_FOR_MS ? primed.snapshot
          : await this.options.transport.request(cmd) as Snapshot;
        this.last = { botId: fresh.chat?.botId, snapshot: fresh };
        return answer(okResponse(id, this.overlay(fresh)));
      }
      if (REMOTE_COMMANDS.has(cmd.type)) {
        const result = await this.options.transport.request(cmd as MobileCommand);
        this.options.onMutated?.();
        return answer(okResponse(id, result));
      }
      if (cmd.type === 'settings.set' && (LOCAL_SETTINGS as readonly string[]).includes(cmd.change.key)) {
        this.local = { ...this.local, [cmd.change.key]: cmd.change.value };
        writeLocal(this.options.storage, this.local);
        // Show it at once from the last read (no server round trip).
        if (this.last) this.primed = { botId: this.last.botId, at: this.now(), snapshot: this.last.snapshot };
        queueMicrotask(() => this.options.onLocalChange?.());
        return answer(okResponse(id, {}));
      }
      if (cmd.type === 'chat.read') return answer(okResponse(id, {}));
      if (cmd.type === 'link.open' && !cmd.reveal && /^https?:\/\//i.test(cmd.url)) {
        this.options.openURL?.(cmd.url);
        return answer(okResponse(id, {}));
      }
      return answer(errorResponse(id, { code: 'forbidden', message: 'Not available in Botling Web. Use the desktop app for this.' }));
    } catch (error) {
      if (error instanceof MobileError) {
        const response = errorResponse(id, { code: error.denied ? 'forbidden' : 'core_unavailable', message: error.message.slice(0, 2_000) });
        return error.auth || error.revoked ? { response, ended: error } : { response };
      }
      return answer(errorResponse(id, { code: 'internal', message: 'Request failed. Check the chat before sending again.' }));
    }
  }

  private emit(message: unknown) {
    for (const listener of [...this.listeners]) listener(message);
  }

  private now() { return (this.options.now ?? Date.now)(); }
}

function readLocal(storage: WebBridgeOptions['storage']): Partial<Record<LocalKey, unknown>> {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const value = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    return Object.fromEntries(Object.entries(value).filter(([key]) => (LOCAL_SETTINGS as readonly string[]).includes(key)));
  } catch { return {}; }
}
function writeLocal(storage: WebBridgeOptions['storage'], value: Partial<Record<LocalKey, unknown>>) {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* Private browsing: this page only. */ }
}

/** Sign-out: this browser forgets the layout it kept (pinned bot ids included). */
export function forgetLocal(storage: Pick<Storage, 'removeItem'> | null | undefined) {
  try { storage?.removeItem(STORAGE_KEY); } catch { /* Storage blocked. */ }
}
