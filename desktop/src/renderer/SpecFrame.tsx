// The component spec workspace in the right panel (1.x's spec panel): the same chat page in spec mode
// (`chat.html?spec=1`, Web/src/spec.ts), fed with the open spec. What it asks (an edit, an answer, words
// for Maintainer, a test run, Build it, Cancel, closing or widening it) becomes `spec.act` and friends;
// its preview's component frames get their pages from main, as the chat's do.
import { useCallback, useEffect, useRef } from "react";
import type { Client } from "./client";
import type { SpecStateView } from "../contract";
import { specState } from "./payload";
import { CHAT_ORIGIN, CHAT_PAGE, CHAT_SANDBOX, CHAT_TARGET, type FrameMessage, type ShellMessage } from "./chat-frame/protocol";

export function SpecFrame({ client, spec, lang, onError }: { client: Client; spec: SpecStateView; lang: string | null; onError: (failure: unknown) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const latest = useRef(spec);
  latest.current = spec;

  const push = useCallback(() => {
    const target = frame.current?.contentWindow;
    if (!target || !ready.current) return;
    const message: ShellMessage = { botling: "spec", spec: specState(latest.current, lang) };
    target.postMessage(message, CHAT_TARGET);
  }, [lang]);
  useEffect(push, [push, spec]);

  useEffect(() => {
    const act = (action: Extract<import("../contract").Command, { type: "spec.act" }>["action"]) =>
      void client.request({ type: "spec.act", specId: latest.current.id, action }).catch(onError);
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow || event.origin !== CHAT_ORIGIN) return;
      const message = event.data as FrameMessage | null;
      if (!message || typeof message !== "object") return;
      if (message.botling === "page") {
        // Its preview's component frame: main serves the page from botling-card://page/.
        const answer = (url: string | null) => {
          const reply: ShellMessage = { botling: "page", id: message.id, url };
          frame.current?.contentWindow?.postMessage(reply, CHAT_TARGET);
        };
        if (typeof message.html !== "string" || typeof message.id !== "number") return;
        client.request({ type: "card.page", html: message.html }).then((result) => answer(result.url), () => answer(null));
        return;
      }
      if (message.botling !== "action") return;
      const action = message.action;
      const text = (value: unknown, limit: number) => (typeof value === "string" ? value.slice(0, limit) : null);
      switch (action?.type) {
        case "ready":
          ready.current = true;
          push();
          return;
        case "specClose": void client.request({ type: "spec.close" }).catch(onError); return;
        case "specWide": if (typeof action.wide === "boolean") void client.request({ type: "spec.wide", wide: action.wide }).catch(onError); return;
        case "specEdit": {
          const key = text(action.key, 40);
          const value = text(action.value, 20_000);
          if (key !== null && value !== null) act({ kind: "edit", key, value });
          return;
        }
        case "specAnswer":
          if (typeof action.question === "string" && typeof action.option === "number" && action.option >= 0 && action.option < 20) act({ kind: "answer", question: action.question.slice(0, 200), option: Math.floor(action.option) });
          return;
        case "specSay": {
          const said = text(action.text, 20_000);
          if (said !== null) act({ kind: "say", text: said, ...(typeof action.request === "string" ? { request: action.request.slice(0, 200) } : {}) });
          return;
        }
        case "specTestRun": {
          const command = text(action.command, 20_000);
          const folder = text(action.folder, 4_000);
          if (command !== null && folder !== null) act({ kind: "testRun", command, folder, ...(typeof action.approve === "boolean" ? { approve: action.approve } : {}) });
          return;
        }
        case "specBuild": act({ kind: "build" }); return;
        case "specCancel": act({ kind: "cancel" }); return;
        default:
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [client, onError, push]);

  return (
    <aside className={`spec-panel${spec.wide ? " wide" : ""}`} aria-label="Component spec">
      <iframe ref={frame} className="spec-frame" src={`${CHAT_PAGE}?spec=1`} sandbox={CHAT_SANDBOX} title="Component spec" />
    </aside>
  );
}
