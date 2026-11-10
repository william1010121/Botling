// The chat column's body under a main-area tab: the tab's frame and the chat page (App.tsx). Normally the wrapper has
// no box of its own (display: contents), so the chat column lays them out as before; with the Note's chat docked
// (note-dock.ts) it becomes a row: the Note, the draggable divider, then the chat at its remembered width
// (`--note-chat-w`). The native chat follows its placeholder's box as usual (editor-surface.ts).
import type { ReactNode } from "react";
import { ColumnDivider } from "./ColumnDivider";

export function ChatBody({ docked, children }: { docked: boolean; children: [ReactNode, ReactNode] }) {
  const [tab, chat] = children;
  return (
    <div className={`chat-body${docked ? " note-docked" : ""}`}>
      {tab}
      {docked && <ColumnDivider column="noteChat" />}
      {chat}
    </div>
  );
}
