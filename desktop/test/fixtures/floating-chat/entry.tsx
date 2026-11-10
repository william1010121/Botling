// The page test/unit/floating-chat-layout.test.ts lays out in an offscreen Electron window: the Note tab with the real
// FloatingChat (strip, panel placement, per-place memory), ChatBody for the docked layout, and the chat's placeholder
// observed by the real observeEditorLayout. A stub bridge records the bounds the native chat would get, and hands the
// shell's floatChrome to the real float-chrome.ts drawn inside the placeholder (standing in for the chat page, whose
// header it is), whose drags and buttons go back to the shell as the native chat's would.
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BotView } from "../../../src/contract";
import { mountFloatChrome, type FloatChrome } from "../../../src/renderer/chat-frame/float-chrome";
import type { ShellMessage } from "../../../src/renderer/chat-frame/protocol";
import { observeEditorLayout, type EditorBridge } from "../../../src/renderer/editor-surface";
import { FloatingChat, floatChatMessage, useFloatMemory } from "../../../src/renderer/FloatingChat";
import { ChatBody } from "../../../src/renderer/NoteDock";
import { ColumnDivider } from "../../../src/renderer/ColumnDivider";

type Box = { x: number; y: number; width: number; height: number } | null;
const native: { chat: Box[] } = { chat: [] };
let chrome: FloatChrome | null = null;
const sent: unknown[] = [];
(window as unknown as { __sent: unknown[] }).__sent = sent;
(window as unknown as { __native: typeof native }).__native = native;
const bridge = {
  current: () => "stamp",
  layout(bounds: Box) { native.chat.push(bounds); return true; },
  subscribe() { return () => {}; },
  post(message: ShellMessage) { if (message.botling === "floatChrome") chrome?.show(message.chrome); return true; },
} as unknown as EditorBridge;
(window as unknown as { botling: { editorHost: EditorBridge } }).botling = { editorHost: bridge };

const bot = { id: "b", name: "botling", role: "bot", avatar: "square", folder: "/w", phase: "awake", working: true, approvals: 0, unread: 2, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] } as unknown as BotView;

const NOTE = `<!doctype html><html><body style="margin:0;background:#0E0E10;color:#EDEDF0;font:14px -apple-system,sans-serif;padding:20px 24px">
${["Botling 版本紀錄|整理自 CHANGELOG.md、git tag 與 main 上的 merge。最新在最上面。", "Unreleased（main，2.6.0 之後）|主題：瀏覽器窗格、Markdown 預覽與 Note 即時卡片。", "2.6.0|"].map((card) => {
  const [title, body] = card.split("|");
  return `<div style="border:1px solid #2E2E35;border-left:3px solid #4C8DFF;border-radius:10px;background:#1B1B1F;padding:14px 16px;margin-bottom:14px"><b style="font-size:15px">${title}</b><p style="color:#A0A0A8;margin:8px 0 10px">${body}</p><div style="height:8px;border-radius:4px;background:#26262C;width:80%;margin-bottom:8px"></div><div style="height:8px;border-radius:4px;background:#26262C;width:55%"></div></div>`;
}).join("")}</body></html>`;

/** The chat page as it would draw in the panel: the header (the real float-chrome.ts), a few lines, the input box. */
function Chat() {
  const placeholder = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => observeEditorLayout(placeholder.current!, bridge, () => true), []);
  useEffect(() => {
    chrome = mountFloatChrome(page.current!, (message) => { sent.push(message); floatChatMessage(message); }, () => false);
    return () => chrome?.dispose();
  }, []);
  return (
    <div id="chat-frame" ref={placeholder} aria-label="Chat" style={{ position: "relative", overflow: "hidden" }}>
      <div ref={page} className="mock-chat" style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--ground)", font: "14px -apple-system, sans-serif", color: "var(--text)" }}>
        <div style={{ flex: 1, padding: "16px 14px", display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 10 }}>
          <div style={{ alignSelf: "flex-end", color: "var(--faint)", fontSize: 11 }}>to Claude</div>
          <div style={{ alignSelf: "flex-end", background: "var(--user-bubble)", borderRadius: 14, padding: "8px 12px" }}>這頁的儲存按鈕顏色太淡</div>
          <div style={{ color: "var(--faint)", fontSize: 11 }}>botling · Claude</div>
          <div style={{ background: "var(--bubble)", borderRadius: 14, padding: "8px 12px", lineHeight: 1.6 }}>改成藍色 #4C8DFF 了，重新整理就看得到。要順便加 hover 效果嗎？</div>
        </div>
        <div style={{ margin: "0 12px 14px", border: "1px solid var(--border)", borderRadius: 14, background: "var(--bubble)", padding: "10px 12px", color: "var(--faint)" }}>Message botling…</div>
      </div>
    </div>
  );
}

function Shell() {
  const [open, setOpen] = useState(false);
  const memory = useFloatMemory();
  const docked = open && memory.note.docked;
  const area = useCallback(() => document.querySelector<HTMLElement>(".main-tab"), []);
  return (
    <div className="shell">
      <aside className="rail"><div className="rail-top drag" /></aside>
      <ColumnDivider column="rail" />
      <section className="chat-pane">
        <div className="chat-column main-tab-on">
          <header className="chat-header drag" />
          <ChatBody docked={docked}>
            <div className="main-tab" role="region" aria-label="Note" data-plugin="botling.note">
              <iframe className="main-tab-frame" sandbox="allow-scripts" srcDoc={NOTE} title="Note" />
              <FloatingChat place="note" bot={bot} look="original" open={open} onOpen={setOpen} line="好的，我把 2.6.0 那段改成條列了" area={area} />
            </div>
            <Chat />
          </ChatBody>
        </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Shell />);
