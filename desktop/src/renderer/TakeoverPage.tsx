// A plugin's page that takes the right panel's place for one bot (`where: "rightPanel.takeover"`, opened with `ui.takeover`; the component
// studio's spec workspace, 1.x's spec panel): the chat page in panel mode (`chat.html?panel=<plugin>/<view>`, chat origin) running only that
// plugin's web part. What the page asks becomes what the chat's own frame does for a web part: a call to the plugin's program part, an ask
// for your OK on this page's ApprovalSheet (the page cannot allow anything), the pages its component frames are drawn on (main serves them
// from botling-card://page/), and what the program part pushes (`ui.emit`) reaches the page as `ccb.on`.
import { useCallback, useEffect, useRef } from "react";
import type { Client } from "./client";
import { RequestFailed } from "./client";
import type { ApprovalAskView, Command, PluginsView } from "../contract";
import { CHAT_ORIGIN, CHAT_PAGE, CHAT_SANDBOX, CHAT_TARGET, type FrameMessage, type ShellMessage } from "./chat-frame/protocol";

export function TakeoverPage({ client, plugin, view, title, botId, wide, plugins, onError, onAsk }: {
  client: Client; plugin: string; view: string; title: string; botId: string; wide: boolean;
  /** The plugins as the app has them: the page is sent its plugin's web part again when they change. */
  plugins: PluginsView | null | undefined;
  onError: (failure: unknown) => void;
  /** An ask for your OK: the app page's ApprovalSheet shows it (the page cannot allow it). */
  onAsk: (view: ApprovalAskView, approve: Command, done?: (allowed: boolean) => void) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const sent = useRef("");
  const post = useCallback((message: ShellMessage) => frame.current?.contentWindow?.postMessage(message, CHAT_TARGET), []);

  // Its plugin's web part, and again when it changes.
  const pushPlugin = useCallback(() => {
    if (!ready.current) return;
    void client.request({ type: "plugins.web" }).then((result) => {
      const specs = result.specs.filter((spec) => spec.name === plugin);
      const text = JSON.stringify(specs);
      if (text === sent.current) return;
      sent.current = text;
      post({ botling: "plugins", specs });
    }, () => {});
  }, [client, plugin, post]);
  useEffect(pushPlugin, [pushPlugin, plugins]);

  // What the program part pushes to this panel (its bot's frames).
  useEffect(() => client.onEvent(({ event }) => {
    if (event.type !== "plugins.emit" || event.plugin !== plugin) return;
    if (event.forBot !== undefined && event.forBot !== botId) return;
    post({ botling: "pluginEvent", plugin, name: event.name, data: event.data });
  }), [client, plugin, botId, post]);

  useEffect(() => {
    const bucket = { tokens: 20, at: Date.now() };
    const paced = () => {
      const now = Date.now();
      bucket.tokens = Math.min(20, bucket.tokens + ((now - bucket.at) / 1000) * 10);
      bucket.at = now;
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    };
    const failure = (error: unknown) => (error instanceof RequestFailed ? error.error.message : String(error));
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow || event.origin !== CHAT_ORIGIN) return;
      const message = event.data as FrameMessage | null;
      if (!message || typeof message !== "object") return;
      if (message.botling === "page") {
        // A component's frame in the page: main serves its page from botling-card://page/.
        const answer = (url: string | null) => post({ botling: "page", id: message.id, url });
        if (typeof message.html !== "string" || typeof message.id !== "number") return;
        client.request({ type: "card.page", html: message.html }).then((result) => answer(result.url), () => answer(null));
        return;
      }
      if (message.botling !== "action") return;
      const action = message.action;
      switch (action?.type) {
        case "ready":
          ready.current = true;
          sent.current = "";
          pushPlugin();
          return;
        // Its own program part only: a call, answered as the chat answers a web part's.
        case "hostCall": {
          if (action.plugin !== plugin || typeof action.method !== "string" || typeof action.callID !== "number") return;
          const callID = action.callID;
          const reply = (ok: boolean, value: unknown) => post({ botling: "hostReply", callID, ok, value });
          if (!paced()) { reply(false, "Too many calls: wait a moment."); return; }
          client.request({ type: "plugins.call", name: plugin, method: action.method.slice(0, 200), params: action.params ?? null, from: "chat" })
            .then((result) => reply(true, result.result), (error) => reply(false, failure(error)));
          return;
        }
        // An ask to allow a command: the core says what it is, and only this page's sheet can allow it.
        case "pluginApproval": {
          if (action.plugin !== plugin || typeof action.callID !== "number" || typeof action.botId !== "string" || typeof action.command !== "string" || typeof action.folder !== "string") return;
          const callID = action.callID;
          const reply = (ok: boolean, value: unknown) => post({ botling: "hostReply", callID, ok, value });
          if (!paced()) { reply(false, "Too many calls: wait a moment."); return; }
          const asked = { botId: action.botId.slice(0, 128), command: action.command.slice(0, 20_000), folder: action.folder.slice(0, 4_000) };
          const card = typeof action.card === "string" && action.card ? action.card.slice(0, 200) : undefined;
          const detail = typeof action.detail === "string" && action.detail ? action.detail.slice(0, 20_000) : undefined;
          client.request({ type: "plugins.approvalAsk", name: plugin, ...asked, from: "chat", ...(card ? { card } : {}), ...(detail ? { detail } : {}) }).then((answer) => {
            const sheet = answer.needsApproval;
            if (!sheet) { reply(true, { allowed: true }); return; }
            onAsk(sheet, { type: "plugins.approve", name: plugin, botId: asked.botId, command: sheet.command, folder: sheet.folder, ...(sheet.detail ? { detail: sheet.detail } : {}) }, (allowed) => reply(true, { allowed }));
          }, (error) => reply(false, failure(error)));
          return;
        }
        default:
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [client, plugin, post, pushPlugin, onError]);

  return (
    <aside className={`takeover-panel${wide ? " wide" : ""}`} aria-label={title} data-plugin={plugin} data-view={view}>
      <iframe ref={frame} className="takeover-frame" src={`${CHAT_PAGE}?panel=${encodeURIComponent(`${plugin}/${view}`)}`} sandbox={CHAT_SANDBOX} title={title} />
    </aside>
  );
}
