// The page's stand-in for the desktop preload (`window.botling`, src/preload): the 2.x renderer (src/renderer, unchanged)
// speaks its envelope bridge to this object, which hands each command to the renderer adapter (src/main-v3/
// renderer-adapter.ts) running here in the page over the front-end link (src/fe-link over an encrypted WebSocket).
//
// Plan change N5 (plan-change-plugin-kernel.md): the renderer is mounted only through `mountRenderer`, into ONE root
// element the shell owns; everything the shell does (pairing, connection banner, "This device", the outbox wiring) stays
// in web-v3/shell/. What the page can do for the renderer is passed in as one plain object (`PageCapabilities`): no
// globals. Things a phone cannot do are answered "not available" here at once, before any slot is written:
//   - commands that need the desktop on this machine (`admin`, machine-security settings);
//   - reads a remote front end may not ask for (protocol/scopes.ts REMOTE_READS);
//   - commands this device's scopes do not cover (its Add's `scope`).
// Per-viewer layout settings (the left column folded, pinned bots…) are kept in this page's memory, as the 2.x page kept
// them in its browser, so the phone never changes the desktop's layout.
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  CancelEnvelope, RequestEnvelope, errorResponse, okResponse,
  type Command, type CommandType, type EventEnvelope, type ResponseEnvelope, type ResultOf,
} from "../src/contract";
import { commandScope, REMOTE_READS, remoteCmdRefusal, type DeviceScope } from "../src/protocol";
import type { Clock } from "../src/fe-link";
import { READ_COMMANDS, RendererAdapter, RequestViaSchema, type LinkPort } from "../src/main-v3/renderer-adapter";
import { App, type WebChrome } from "../src/renderer/App";
import { Client, type Bridge, type RequestVia } from "../src/renderer/client";
import { WorkspaceStore } from "../src/renderer/store";
import { phoneLayout } from "../mobile/layout";
import type { PendingFileView } from "../src/contract";
import type { PageUploadsPort } from "./shell/uploads";

/** What the page offers the renderer (the future `needsShell` list). One plain object, given to `mountRenderer`. */
export interface PageCapabilities {
  /** Opens an http(s) link outside the page (a new tab). */
  openLink(url: string): void;
  /** A phone-width page: the left column is a drawer, never folded. */
  narrow(): boolean;
  /** This device's scopes (from its Add). */
  scopes: readonly DeviceScope[];
  /** The reads the server answers for a remote front end. Default: protocol REMOTE_READS. */
  remoteReads?: ReadonlySet<CommandType>;
  /**
   * This page's attachments (M2 step 12, web-v3/shell/uploads.ts): their chips are merged into the input box's pending
   * files, `files.remove` of one is answered here, and a `chat.send` takes them as `files` (hash-named uploads).
   */
  uploads?: PageUploadsPort;
}

/** Layout settings this page keeps for itself. */
export const LOCAL_SETTINGS = ["rightPanelCollapsed", "railCollapsed", "pinnedBots", "idleBots"] as const;
type LocalKey = typeof LOCAL_SETTINGS[number];
export const NOT_AVAILABLE = "Not available on this device. Use the Botling desktop app for this.";

type Snapshot = ResultOf<"chat.snapshot">;
/** The adapter's request port (RendererAdapter has it). */
export interface AdapterPort { request(cmd: Command, via?: RequestVia): ReturnType<RendererAdapter["request"]> }

/** Why the page answers `cmd` itself with "not available", or null when it goes to the server. */
export function pageRefusal(cmd: Command, capabilities: Pick<PageCapabilities, "scopes" | "remoteReads">): string | null {
  const scope = commandScope(cmd);
  if (scope === "admin" || scope === "machine") return NOT_AVAILABLE;
  if (cmd.type === "chat.snapshot" || cmd.type === "chat.history") return null;
  const reads = capabilities.remoteReads ?? REMOTE_READS;
  if (READ_COMMANDS.has(cmd.type) || scope === "read") return reads.has(cmd.type) && capabilities.scopes.includes("read") ? null : NOT_AVAILABLE;
  return remoteCmdRefusal(cmd, capabilities.scopes) ? NOT_AVAILABLE : null;
}

export class BridgeV3 implements Bridge {
  readonly protocol = 2;
  private readonly listeners = new Set<(message: unknown) => void>();
  private readonly cancelled = new Set<string>();
  private readonly local: Partial<Record<LocalKey, unknown>> = {};
  private closed = false;
  /** The server's own input-box files per bot (from the snapshot and `files.updated`). */
  private readonly serverPending = new Map<string, PendingFileView[]>();
  /** Told when a layout setting changed here (the caller resyncs the store). */
  onLocalChange: () => void = () => undefined;

  constructor(private readonly adapter: AdapterPort, private readonly capabilities: PageCapabilities) {}

  /** The adapter's event port. */
  emit(envelope: EventEnvelope | ResponseEnvelope): void {
    if (this.closed) return;
    // The server's input-box files of a bot, with this page's chips after them (the event keeps its epoch and seq).
    if ("event" in envelope && envelope.event.type === "files.updated") {
      const event = envelope.event;
      this.serverPending.set(event.botId, event.files);
      const mine = this.capabilities.uploads?.pending(event.botId) ?? [];
      if (mine.length) envelope = { ...envelope, event: { ...event, files: [...event.files, ...mine].slice(0, 50) } };
    }
    for (const listener of [...this.listeners]) listener(envelope);
  }

  post(envelope: unknown, via?: RequestVia): void {
    if (this.closed) return;
    const cancel = CancelEnvelope.safeParse(envelope);
    if (cancel.success) {
      // A read on the session cannot be withdrawn; its answer is dropped and the caller hears "cancelled".
      this.cancelled.add(cancel.data.cancel);
      this.emit(errorResponse(cancel.data.cancel, { code: "cancelled", message: "The request was cancelled." }));
      return;
    }
    const request = RequestEnvelope.safeParse(envelope);
    if (!request.success) return;
    const { id, cmd } = request.data;
    void this.handle(id, cmd, via).then((response) => {
      if (this.cancelled.delete(id)) return;
      this.emit(response);
    });
  }

  subscribe(listener: (message: unknown) => void): () => void {
    if (typeof listener !== "function") throw new TypeError("subscribe takes a function");
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }

  private async handle(id: string, cmd: Command, via?: RequestVia): Promise<ResponseEnvelope> {
    let validVia: RequestVia | undefined;
    if (via !== undefined) {
      const parsedVia = RequestViaSchema.safeParse(via);
      if (!parsedVia.success) return errorResponse(id, { code: "bad_request", message: "Malformed request attribution (via)." });
      validVia = parsedVia.data;
    }
    const uploads = this.capabilities.uploads;
    if (validVia) {
      if (
        (cmd.type === "settings.set" && (LOCAL_SETTINGS as readonly string[]).includes(cmd.change.key)) ||
        cmd.type === "link.open" ||
        (cmd.type === "files.remove" && uploads?.owns(cmd.botId, cmd.id))
      ) {
        return errorResponse(id, { code: "forbidden", message: "not sent: plugins cannot invoke local page shortcuts" });
      }
    }
    if (cmd.type === "settings.set" && (LOCAL_SETTINGS as readonly string[]).includes(cmd.change.key)) {
      this.local[cmd.change.key as LocalKey] = cmd.change.value;
      queueMicrotask(() => this.onLocalChange());
      return okResponse(id, {});
    }
    if (cmd.type === "link.open") {
      if (!cmd.reveal && /^https?:\/\//i.test(cmd.url)) { this.capabilities.openLink(cmd.url); return okResponse(id, {}); }
      return errorResponse(id, { code: "forbidden", message: NOT_AVAILABLE });
    }
    if (cmd.type === "files.remove" && uploads?.owns(cmd.botId, cmd.id)) {
      uploads.remove(cmd.botId, cmd.id);
      return okResponse(id, { files: this.pendingOf(cmd.botId) });
    }
    const refusal = pageRefusal(cmd, this.capabilities);
    if (refusal) return errorResponse(id, { code: "forbidden", message: refusal });
    let taken: Awaited<ReturnType<PageUploadsPort["take"]>> = [];
    if (cmd.type === "chat.send" && uploads && !cmd.files) {
      // The command names the files by their hash; the bytes may still be on their way (the server holds it).
      try { taken = await uploads.take(cmd.botId); } catch (error) {
        return errorResponse(id, { code: "bad_request", message: String((error as Error)?.message ?? error) });
      }
      if (taken.length) cmd = { ...cmd, files: taken };
    }
    let answer: Awaited<ReturnType<AdapterPort["request"]>>;
    try { answer = validVia ? await this.adapter.request(cmd, validVia) : await this.adapter.request(cmd); } catch (error) {
      if (taken.length && cmd.type === "chat.send") uploads?.untake(cmd.botId, taken);
      throw error;
    }
    if (!answer.ok && taken.length && cmd.type === "chat.send") uploads?.untake(cmd.botId, taken);
    if (!answer.ok) return errorResponse(id, answer.error);
    return okResponse(id, cmd.type === "chat.snapshot" ? this.overlay(answer.result as Snapshot) : answer.result);
  }

  /** The input box's files of a bot: the server's, then this page's chips. */
  private pendingOf(botId: string): PendingFileView[] {
    return [...(this.serverPending.get(botId) ?? []), ...(this.capabilities.uploads?.pending(botId) ?? [])].slice(0, 50);
  }

  /** The settings the renderer sees: the server's display settings with this page's layout on top; this page's chips. */
  private overlay(snapshot: Snapshot): Snapshot {
    if (snapshot.chat) {
      this.serverPending.set(snapshot.chat.botId, snapshot.chat.pendingFiles ?? []);
      if (this.capabilities.uploads) snapshot = { ...snapshot, chat: { ...snapshot.chat, pendingFiles: this.pendingOf(snapshot.chat.botId) } };
    }
    if (!snapshot.settings) return snapshot;
    const settings = { ...snapshot.settings } as Record<string, unknown>;
    for (const key of LOCAL_SETTINGS) if (key in this.local) settings[key] = this.local[key];
    return { ...snapshot, settings: phoneLayout(settings as Snapshot["settings"] & { railCollapsed?: boolean }, this.capabilities.narrow()) as Snapshot["settings"] };
  }
}

export interface MountOptions {
  link: LinkPort;
  capabilities: PageCapabilities;
  clock: Clock;
  /** The shell's controls placed in the renderer's chrome (the drawer button, the "This device" entry). */
  chrome: WebChrome;
  audit?: (text: string) => void;
}

export interface MountedRenderer {
  adapter: RendererAdapter;
  store: WorkspaceStore;
  /** Re-renders with new chrome (the drawer state changed). */
  render(chrome: WebChrome): void;
  unmount(): void;
}

/** Mounts the unchanged 2.x renderer into `root` (the one element the shell gives it). Call before the link starts. */
export function mountRenderer(root: HTMLElement, options: MountOptions): MountedRenderer {
  let bridge: BridgeV3 | null = null;
  const adapter = new RendererAdapter({ link: options.link, emit: (envelope) => bridge?.emit(envelope), clock: options.clock, audit: options.audit });
  bridge = new BridgeV3(adapter, options.capabilities);
  const client = new Client(bridge);
  const store = new WorkspaceStore((botId) => client.request({ type: "chat.snapshot", ...(botId ? { botId } : {}) }));
  client.onEvent((event) => store.receive(event));
  bridge.onLocalChange = () => { void store.resync().catch(() => undefined); };
  const offChips = options.capabilities.uploads?.onChipsChanged(() => bridge?.onLocalChange()) ?? (() => undefined);
  adapter.start();
  const reactRoot: Root = createRoot(root);
  const render = (chrome: WebChrome) => reactRoot.render(createElement(App, { client, store, web: chrome }));
  render(options.chrome);
  void store.resync().catch((error) => options.audit?.(`first snapshot: ${String((error as Error)?.message ?? error)}`));
  return {
    adapter, store, render,
    unmount() { offChips(); adapter.stop(); bridge?.close(); reactRoot.unmount(); },
  };
}
