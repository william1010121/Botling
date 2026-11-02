// The app page's own confirmation for a card's command (plugin-platform.md §5.4, G2): the command, its folder and
// Detail command as the core has them, and "Allow and run". It lives in this page's React, never in a chat or card
// frame, so nothing a frame runs can press it; what it sends (`component.approve`, `pin.approve`, `spec.approve`,
// `whiteboard.allow`, `plugins.approve`) has no route from a frame. Its Allow waits a moment after it opens, so a sheet a frame made
// appear under your pointer is not allowed by the click you were already making.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ApprovalAskView, Command } from "../contract";
import type { Client } from "./client";
import { approvalWords } from "./approval-text";
import { ShellOverlay } from "./ShellOverlay";

/** How long Allow stays off after the sheet opens. */
export const ARM_MS = 500;

export function ApprovalSheet({ ask, lang, onAllow, onCancel, armMs = ARM_MS }: { ask: ApprovalAskView; lang: string | null | undefined; onAllow: () => void; onCancel: () => void; armMs?: number }) {
  const words = approvalWords(lang);
  const [armed, setArmed] = useState(armMs <= 0);
  useEffect(() => {
    if (armMs <= 0) return;
    const timer = setTimeout(() => setArmed(true), armMs);
    return () => clearTimeout(timer);
  }, [armMs]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCancel]);
  return (
    <ShellOverlay><div className="dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="dialog approval-sheet" role="alertdialog" aria-labelledby="approval-title" aria-describedby="approval-line">
        <h2 id="approval-title">{words.title}</h2>
        <p id="approval-line">{words.line(ask.card)}</p>
        <code className="approval-folder">{ask.folder}</code>
        <pre className="approval-command">{ask.command}</pre>
        {ask.detail !== null && <>
          <p className="approval-detail-line">{words.detailLine}</p>
          <pre className="approval-command approval-detail">{ask.detail}</pre>
        </>}
        <p className="approval-note">{words.remembered}</p>
        <div className="dialog-buttons">
          <button type="button" className="dialog-cancel" onClick={onCancel} autoFocus>{words.cancel}</button>
          <button type="button" className="dialog-primary approval-allow" disabled={!armed} onClick={onAllow}>{words.allow}</button>
        </div>
      </div>
    </div></ShellOverlay>
  );
}

/**
 * One sheet at a time for a page: `ask` opens it for what the core answered, with the command its Allow sends. While
 * one is open, another ask is ignored (a frame cannot swap what you are reading for something else). `done` hears
 * how it ended: true once Allow was pressed and the core accepted it; false for Cancel, a failure or an ignored ask.
 */
export function useApprovalSheet(client: Client, lang: string | null | undefined, onError: (failure: unknown) => void, armMs = ARM_MS): { ask: (view: ApprovalAskView, approve: Command, done?: (allowed: boolean) => void) => void; sheet: ReactNode } {
  type Open = { view: ApprovalAskView; approve: Command; done?: (allowed: boolean) => void };
  const [open, setOpen] = useState<Open | null>(null);
  const current = useRef(open);
  const ask = useCallback((view: ApprovalAskView, approve: Command, done?: (allowed: boolean) => void) => {
    if (current.current) { done?.(false); return; }
    current.current = { view, approve, ...(done ? { done } : {}) };
    setOpen(current.current);
  }, []);
  const close = useCallback(() => { current.current = null; setOpen(null); }, []);
  const sheet = open && (
    <ApprovalSheet ask={open.view} lang={lang} armMs={armMs} onCancel={() => { close(); open.done?.(false); }}
      onAllow={() => {
        close();
        void client.request(open.approve).then(
          (result) => open.done?.((result as { accepted?: unknown } | null)?.accepted === true),
          (failure) => { open.done?.(false); onError(failure); },
        );
      }} />
  );
  return { ask, sheet };
}
