// The app page's side of a plugin's `composerBar` view (chat-frame/composer-bar.ts draws it in the chat page,
// at the right end of the row above the input box). This page makes the view's two pages for the bot on
// screen (panel-page.ts, `ccb.context` { botId, surface: "compact" | "expanded" }), tells the chat page, and
// answers what those frames post exactly as it answers a plugin frame of its own (frame-broker.ts): the
// frames sit in the chat page, so the chat page passes their messages here and their replies back.
import { useEffect, useRef } from "react";
import type { PluginsView } from "../contract";
import type { Client } from "./client";
import { frameEvent } from "../../../Web/src/frame-protocol";
import { FrameBroker, registerPluginFrame } from "./frame-broker";
import { pluginFrameHost } from "./plugin-frame-host";
import { panelPage } from "./panel-page";
import { nativeEditor, postToChat } from "./editor-surface";
import type { BuiltinRunner, FrameServices } from "./Plugins";
import type { ComposerBarFrame, ComposerBarSpec, FrameMessage, ShellMessage } from "./chat-frame/protocol";

export type ComposerBarView = NonNullable<PluginsView["composerBarViews"]>[number];

/** The text size of both frames (the pin chips' 12px). */
const FONT_SIZE = 12;

let inbox: ((message: FrameMessage) => void) | null = null;
/** A chat page message about the composer bar, for `useComposerBar`; false: not one. */
export function composerBarMessage(message: FrameMessage): boolean {
  if (message.botling !== "composerBarAsk" && message.botling !== "composerBarFrame") return false;
  inbox?.(message);
  return true;
}

/**
 * A frame broker that hears what the chat page passes on instead of window messages: each of the two frames is
 * a stand-in whose `postMessage` goes back through the chat page to the real frame.
 */
export function relayBroker(send: (frame: ComposerBarFrame, data: unknown) => void) {
  let listener: ((event: MessageEvent) => void) | null = null;
  const page = { addEventListener: (_: string, fn: (event: MessageEvent) => void) => { listener = fn; }, removeEventListener: () => { listener = null; } } as unknown as Window & { parent: unknown };
  (page as { parent: unknown }).parent = page;
  const broker = new FrameBroker(page, { name: "composer bar broker" });
  const stand = (which: ComposerBarFrame) => ({ contentWindow: { postMessage: (data: unknown) => send(which, data) } }) as unknown as HTMLIFrameElement;
  const frames = { compact: stand("compact"), expanded: stand("expanded") };
  return {
    broker, frames,
    /** What the chat page passed on from `which` (it checked the window and the opaque origin). */
    deliver: (which: ComposerBarFrame, data: unknown) => listener?.({ source: frames[which].contentWindow, origin: "null", data } as MessageEvent),
  };
}

export function useComposerBar({ client, view, botId, onBuiltin, ...services }: { client: Client; view: ComposerBarView | null; botId: string | null; onBuiltin?: BuiltinRunner } & FrameServices): void {
  const now = useRef(services);
  now.current = services;
  const builtin = useRef(onBuiltin);
  builtin.current = onBuiltin;
  const spec = useRef<ComposerBarSpec | null>(null);
  const plugin = view?.plugin, id = view?.id, title = view?.title, width = view?.width;

  // What the row shows: told now, again when the chat page asks (it loaded again) and when the native chat binds again.
  useEffect(() => {
    const tell = () => postToChat({ botling: "composerBar", bar: spec.current } satisfies ShellMessage);
    const bridge = nativeEditor();
    return bridge?.subscribe((packet) => { if ("bound" in packet) tell(); });
  }, []);

  useEffect(() => {
    const tell = () => postToChat({ botling: "composerBar", bar: spec.current } satisfies ShellMessage);
    spec.current = null;
    if (!plugin || !id || !botId) { tell(); inbox = (message) => { if (message.botling === "composerBarAsk") tell(); }; return () => { inbox = null; }; }
    let live = true;
    const relay = relayBroker((frame, data) => postToChat({ botling: "composerBarReply", frame, data } satisfies ShellMessage));
    const host = {
      ...pluginFrameHost({
        client,
        components: () => now.current.components ?? {},
        bots: () => now.current.bots ?? [],
        ask: (asked, approve, done) => (now.current.ask ? now.current.ask(asked, approve, done) : done(false)),
      }),
      builtin: (name: string, command: Parameters<BuiltinRunner>[1]) => builtin.current?.(name, command),
    };
    const quiet = { onNotice: (text: string) => console.warn(`[composer bar] ${plugin}: ${text}`), onError: (text: string) => console.warn(`[composer bar] ${plugin} failed: ${text}`) };
    const stops = (["compact", "expanded"] as const).map((which) => registerPluginFrame(relay.broker, host, { frame: relay.frames[which], plugin, ...quiet }));
    inbox = (message) => {
      if (message.botling === "composerBarAsk") tell();
      else if (message.botling === "composerBarFrame" && (message.frame === "compact" || message.frame === "expanded")) relay.deliver(message.frame, message.data);
    };
    // What the program part pushes (`ui.emit`) goes to both frames: every push, or those for this bot.
    const stopEvents = client.onEvent(({ event }) => {
      if (event.type !== "plugins.emit" || event.plugin !== plugin) return;
      if (event.forBot !== undefined && event.forBot !== botId) return;
      for (const frame of ["compact", "expanded"] as const) postToChat({ botling: "composerBarReply", frame, data: frameEvent(event.name, event.data) } satisfies ShellMessage);
    });
    const page = (source: string, settings: Record<string, unknown>, surface: ComposerBarFrame) =>
      client.request({ type: "card.page", html: panelPage(plugin, id, source, settings, { fontSize: FONT_SIZE }, { botId, surface }), panel: true }).then((made) => made.url);
    client.request({ type: "plugins.panel", name: plugin, panel: id })
      .then((part) => Promise.all([page(part.source, part.settings, "compact"), page(part.source, part.settings, "expanded")]))
      .then(([compact, expanded]) => {
        if (!live) return;
        spec.current = { plugin, view: id, title: title ?? id, width: width ?? 240, compact, expanded };
        tell();
      }, (failure) => console.warn(`[composer bar] ${plugin}: ${failure instanceof Error ? failure.message : String(failure)}`));
    return () => {
      live = false;
      inbox = null;
      stopEvents();
      for (const stop of stops) stop();
      relay.broker.dispose();
      spec.current = null;
      tell();
    };
  }, [client, plugin, id, title, width, botId]);
}
