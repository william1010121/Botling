// The page test/unit/column-resize-layout.test.ts lays out in an offscreen Electron window: the shell's columns as
// App.tsx draws them with the browser pane open, the real ColumnDivider, BrowserPane and right panel, the native
// chat's placeholder observed by the real observeEditorLayout. A stub bridge records the bounds each native view would
// get (the chat's `layout`, the browser page's `layout` message), which is what main's setBounds follows.
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { BotView } from "../../../src/contract";
import { BrowserPane } from "../../../src/renderer/BrowserPane";
import { ColumnDivider } from "../../../src/renderer/ColumnDivider";
import { observeEditorLayout, type EditorBridge } from "../../../src/renderer/editor-surface";
import { RightPanel } from "../../../src/renderer/RightPanel";

type Box = { x: number; y: number; width: number; height: number } | null;
const native: { chat: Box[]; page: Box[] } = { chat: [], page: [] };
(window as unknown as { __native: typeof native }).__native = native;
(window as unknown as { botling: unknown }).botling = {
  browser: {
    post(message: { type: string; bounds?: Box }) { if (message.type === "layout") native.page.push(message.bounds ?? null); },
    subscribe() { return () => {}; },
  },
};
const bridge = { current: () => "stamp", layout(bounds: Box) { native.chat.push(bounds); return true; }, subscribe() { return () => {}; } } as unknown as EditorBridge;

const bot = { id: "b", name: "Bot", role: "bot", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] } as unknown as BotView;

function Chat() {
  const placeholder = useRef<HTMLDivElement>(null);
  useEffect(() => observeEditorLayout(placeholder.current!, bridge, () => true), []);
  return <div id="chat-frame" ref={placeholder} aria-label="Chat" style={{ position: "relative", overflow: "hidden" }} />;
}

function Shell() {
  return (
    <div className="shell browser-on">
      <aside className="rail"><div className="rail-top drag" /></aside>
      <ColumnDivider column="rail" />
      <section className="chat-pane"><div className="chat-column"><header className="chat-header drag" /><Chat /></div></section>
      <ColumnDivider column="browser" />
      <BrowserPane bot={bot} state={{ botId: bot.id, tabs: [{ id: 1, url: "https://example.com/", title: "Example", loading: false, canGoBack: false }], active: 1 } as never}
        full={false} look="original" miniChat={false} onMiniChat={() => {}} layoutKey="k" onAskTool={async () => {}} />
      <ColumnDivider column="right" />
      <RightPanel bot={bot} bots={[bot]} waiting={{ items: [], doing: {} }} look="original" status={{ key: "awake", text: "Awake" }} results={[]} watching={null} collapsed={false}
        onSelect={() => {}} onIgnore={() => {}} onOpenResult={() => {}} onOpenSubagent={() => {}} onUnsettle={() => {}} onSettings={() => {}} onExpand={() => {}} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Shell />);
