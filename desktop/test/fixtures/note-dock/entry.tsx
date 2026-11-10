// The page test/unit/note-dock-layout.test.ts lays out in an offscreen Electron window: the chat column on the Note
// tab as App.tsx draws it, with the real ChatBody, ColumnDivider, BotBubble and dock state (note-dock.ts), the Note's
// frame and the native chat's placeholder observed by the real observeEditorLayout. A stub bridge records the bounds
// the native chat would get (main's setBounds follows them).
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BotView } from "../../../src/contract";
import { BotBubble } from "../../../src/renderer/BotBubble";
import { ColumnDivider } from "../../../src/renderer/ColumnDivider";
import { observeEditorLayout, type EditorBridge } from "../../../src/renderer/editor-surface";
import type { MainTab } from "../../../src/renderer/main-tabs";
import { dockKey, docked, toggleDock } from "../../../src/renderer/note-dock";
import { ChatBody } from "../../../src/renderer/NoteDock";

type Box = { x: number; y: number; width: number; height: number } | null;
const native: { chat: Box[] } = { chat: [] };
(window as unknown as { __native: typeof native }).__native = native;
const bridge = { current: () => "stamp", layout(bounds: Box) { native.chat.push(bounds); return true; }, subscribe() { return () => {}; } } as unknown as EditorBridge;

const bot = { id: "b", name: "Bot", role: "bot", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 2, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] } as unknown as BotView;
const note = { plugin: "botling.note", id: "note", title: "Note", forRole: "any" } as MainTab;

function Chat() {
  const placeholder = useRef<HTMLDivElement>(null);
  useEffect(() => observeEditorLayout(placeholder.current!, bridge, () => true), []);
  return <div id="chat-frame" ref={placeholder} aria-label="Chat" style={{ position: "relative", overflow: "hidden" }} />;
}

function Shell() {
  const key = dockKey(bot.id, note, false);
  const [open, setOpen] = useState<string | null>(null);
  const on = docked(open, key);
  return (
    <div className="shell">
      <aside className="rail"><div className="rail-top drag" /></aside>
      <ColumnDivider column="rail" />
      <section className="chat-pane">
        <div className="chat-column main-tab-on">
          <header className="chat-header drag" />
          <ChatBody docked={on}>
            <div className="main-tab" role="region" aria-label="Note" data-plugin="botling.note">
              <iframe className="main-tab-frame" sandbox="allow-scripts" srcDoc="<p>Note</p>" title="Note" />
              <BotBubble bot={bot} look="original" on={on} onToggle={() => setOpen((now) => toggleDock(now, key))} className="note-bubble" />
            </div>
            <Chat />
          </ChatBody>
        </div>
      </section>
      <ColumnDivider column="right" />
      <aside className="detail-panel" />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Shell />);
