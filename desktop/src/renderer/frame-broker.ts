// The frame broker: the one listener for a page's sandboxed frames (a plugin's panel in the app
// page, bots' cards in the chat page). A message counts only if it came from a frame the page
// registered (matched by `event.source`, never by anything in the message) whose origin is still
// opaque (sandboxed). Who sent it is that registration, so a frame only ever speaks for itself. Each
// frame is paced: 20 calls at once, then 10 a second.
//
// A plugin's frame speaks the frame protocol (Web/src/frame-protocol.ts): `registerPluginFrame` turns
// its calls into `plugins.call` with the plugin the page registered it for (`from: "frame"`), runs
// only that plugin's own commands (with their few string arguments) and Botling's own openChat /
// openResult, which the page runs itself, and answers each call. The core checks the method is one the
// plugin exposed (ui.expose). A frame may also ask for a tile (a card page of a library component it
// may frame) and ask the user to allow a bot's command (`ccb.requestApproval`): the page answers both
// itself (plugin-frame-host.ts); the approval is the page's own ApprovalSheet, so a frame can only ask.
import { BUILTIN_COMMANDS, builtinCommand, frameParams, frameReply, ownsCommand, parseFrameRequest, type BuiltinCommand, type FrameRequest } from "../../../Web/src/frame-protocol";

export interface FrameTarget {
  frame: HTMLIFrameElement;
  /** How refusals name it. */
  label: string;
  /** A message from this frame (its window and opaque origin already checked). */
  receive(data: unknown): void;
  /** How often it may call, when more than most frames (a panel that streams, like a terminal's input and acknowledgements). */
  rate?: { burst: number; perSecond: number };
}

export interface Refusal { at: number; reason: string; card: string | null }

export interface FrameBrokerOptions {
  /** A message from a frame nobody registered that is someone else's to answer (not refused). */
  ignore?(source: MessageEventSource | null): boolean;
  /** What the console calls this broker, and what it calls a frame. */
  name?: string;
  frame?: string;
}

const RATE = { burst: 20, perSecond: 10 };

export class FrameBroker {
  private targets = new Set<FrameTarget>();
  private buckets = new WeakMap<FrameTarget, { tokens: number; at: number }>();
  readonly refusals: Refusal[] = [];

  constructor(private page: Window = window, private options: FrameBrokerOptions = {}) {
    page.addEventListener("message", this.onMessage);
  }

  register(target: FrameTarget): () => void {
    this.targets.add(target);
    return () => { this.targets.delete(target); };
  }

  dispose() {
    this.page.removeEventListener("message", this.onMessage);
    this.targets.clear();
  }

  refuse(reason: string, target: FrameTarget | null) {
    const entry = { at: Date.now(), reason, card: target?.label ?? null };
    this.refusals.push(entry);
    if (this.refusals.length > 200) this.refusals.shift();
    console.warn(`[${this.options.name ?? "frame broker"}] refused: ${reason}`, entry.card ?? "");
  }

  /** Spends one of the frame's calls; false: it is calling too often. */
  allow(target: FrameTarget): boolean {
    const now = Date.now();
    const rate = target.rate ?? RATE;
    const bucket = this.buckets.get(target) ?? { tokens: rate.burst, at: now };
    bucket.tokens = Math.min(rate.burst, bucket.tokens + ((now - bucket.at) / 1000) * rate.perSecond);
    bucket.at = now;
    this.buckets.set(target, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private onMessage = (event: MessageEvent) => {
    // Not from a frame at all (this page itself, or the page it sits in): not ours to handle.
    if (event.source === this.page || (this.page.parent !== this.page && event.source === this.page.parent)) return;
    let sender: FrameTarget | null = null;
    for (const target of this.targets) if (target.frame.contentWindow && target.frame.contentWindow === event.source) sender = target;
    if (!sender) {
      if (!this.options.ignore?.(event.source)) this.refuse(`a message from a frame that is not a registered ${this.options.frame ?? "frame"}`, null);
      return;
    }
    if (event.origin !== "null") {
      this.refuse(`a frame with origin ${event.origin} (expected an opaque, sandboxed origin)`, sender);
      return;
    }
    sender.receive(event.data);
  };
}

/** What a plugin frame's requests become: contract commands for the frame's own plugin. */
export interface PluginFrameHost {
  call(plugin: string, method: string, params: unknown): Promise<unknown>;
  command(plugin: string, id: string, args?: string[]): Promise<unknown>;
  /** Botling's own command (botling.openChat / openResult), run by the page; none: refused. */
  builtin?(plugin: string, command: BuiltinCommand): void;
  /** A tile's card page for `plugin`'s frame: its URL (a page without these refuses). */
  tile?(plugin: string, spec: Omit<Extract<FrameRequest, { ccb: "tile" }>, "ccb" | "id">): Promise<string>;
  /** A component's card page drawn as in a chat reply, for `plugin`'s frame: its URL (`ccb.card`). */
  card?(plugin: string, spec: Omit<Extract<FrameRequest, { ccb: "card" }>, "ccb" | "id">): Promise<string>;
  /** A picture of `rect` of `frame` (its own CSS px), kept in the bot's note (`ccb.snapshot`). */
  snapshot?(plugin: string, frame: HTMLIFrameElement, spec: Omit<Extract<FrameRequest, { ccb: "snapshot" }>, "ccb" | "id">): Promise<unknown>;
  /** Opens a link of a bot's note as a chat link opens (`ccb.openLink`). */
  openLink?(plugin: string, spec: Omit<Extract<FrameRequest, { ccb: "openLink" }>, "ccb" | "id">): Promise<unknown>;
  /** The page's own ApprovalSheet for what `plugin`'s frame asks: whether the user allowed it. */
  requestApproval?(plugin: string, ask: Omit<Extract<FrameRequest, { ccb: "approval" }>, "ccb" | "id">): Promise<{ allowed: boolean }>;
}

export interface PluginFrame {
  frame: HTMLIFrameElement;
  plugin: string;
  onNotice?(text: string): void;
  onError?(message: string): void;
  /** How tall its content is (px); a frame sized to its content (`panelPage` with `fit`) says so. */
  onResize?(height: number): void;
  /** Its web part is up. */
  onReady?(): void;
  /** A `bottomPanel` view asks to be shown or hidden. */
  onPanel?(visible: boolean): void;
  /** A key combination it did not use, for the page's own shortcuts. */
  onKey?(key: Extract<FrameRequest, { ccb: "key" }>): void;
  /** See `FrameTarget.rate`. */
  rate?: { burst: number; perSecond: number };
}

/** Hears a plugin's frame; who it is comes from here, never from its messages. */
export function registerPluginFrame(broker: FrameBroker, host: PluginFrameHost, { frame, plugin, onNotice, onError, onResize, onReady, onPanel, onKey, rate }: PluginFrame): () => void {
  const target: FrameTarget = {
    frame,
    label: plugin,
    ...(rate ? { rate } : {}),
    receive(data) {
      const message = parseFrameRequest(data);
      if (!message) {
        const kind = (data as { ccb?: unknown } | null)?.ccb;
        // Its page says it is ready; nothing to answer.
        if (kind === "ready") onReady?.();
        else broker.refuse(`a message that is not a valid ccb call (${typeof kind === "string" ? kind.slice(0, 40) : typeof data})`, target);
        return;
      }
      const reply = (id: number, ok: boolean, value: unknown) => frame.contentWindow?.postMessage(frameReply(id, ok, value), "*");
      switch (message.ccb) {
        case "call": {
          if (!broker.allow(target)) { reply(message.id, false, "Too many calls; wait a moment."); return; }
          const params = frameParams(message.params);
          if (!params.ok) { reply(message.id, false, params.reason); return; }
          host.call(plugin, message.method, params.value).then((value) => reply(message.id, true, value), (failure) => reply(message.id, false, why(failure)));
          return;
        }
        case "command": {
          if ((BUILTIN_COMMANDS as readonly string[]).includes(message.id)) {
            const command = builtinCommand(message.id, message.args);
            if (!host.builtin) { broker.refuse(`Botling's command "${message.id}" (this page runs none)`, target); return; }
            if (!command) { broker.refuse(`Botling's command "${message.id}" with the wrong arguments`, target); return; }
            if (!broker.allow(target)) { broker.refuse("too many calls", target); return; }
            host.builtin(plugin, command);
            return;
          }
          if (!ownsCommand(plugin, message.id)) { broker.refuse(`a command of another plugin ("${message.id}")`, target); return; }
          if (!broker.allow(target)) { broker.refuse("too many calls", target); return; }
          host.command(plugin, message.id, message.args).catch((failure) => onNotice?.(why(failure)));
          return;
        }
        case "tile":
        case "card":
        case "snapshot":
        case "openLink":
        case "approval": {
          if (!broker.allow(target)) { reply(message.id, false, "Too many calls; wait a moment."); return; }
          const { ccb: kind, id, ...ask } = message;
          const answer = kind === "tile" ? host.tile?.(plugin, ask as never)
            : kind === "card" ? host.card?.(plugin, ask as never)
            : kind === "snapshot" ? host.snapshot?.(plugin, frame, ask as never)
            : kind === "openLink" ? host.openLink?.(plugin, ask as never)
            : host.requestApproval?.(plugin, ask as never);
          if (!answer) { reply(id, false, `This page does not answer ccb.${kind === "approval" ? "requestApproval" : kind}.`); return; }
          answer.then((value) => reply(id, true, value), (failure) => reply(id, false, why(failure)));
          return;
        }
        case "notify":
          onNotice?.(message.text.slice(0, 400));
          return;
        case "resize":
          onResize?.(message.height);
          return;
        case "panel":
          if (!broker.allow(target)) { broker.refuse("too many calls", target); return; }
          onPanel?.(message.visible);
          return;
        case "key":
          if (!broker.allow(target)) { broker.refuse("too many calls", target); return; }
          onKey?.(message);
          return;
        case "error":
          onError?.(message.message.slice(0, 400));
      }
    },
  };
  return broker.register(target);
}

function why(failure: unknown): string {
  const error = failure as { error?: { message?: unknown }; message?: unknown } | null;
  const text = error?.error?.message ?? error?.message ?? failure;
  return String(text).slice(0, 2_000);
}
