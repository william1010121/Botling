import { useCallback, useState, type ReactNode } from "react";
import type { LeaveMarks } from "./sub-bot-nav";

/** Where you left each project bot for its sub bot (its newest line then): the chat page's "New while you were in X". */
export const leaveMarks: { current: LeaveMarks } = { current: {} };
/** ⌘⌥1–9's shortcut ids, by the number. */
export const PINNED_KEYS = ([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => `pinnedSubBot${n}` as const);
export const pinnedNumber = (id: string | null | undefined): number | null => { const n = /^pinnedSubBot([1-9])$/.exec(id ?? "")?.[1]; return n ? Number(n) : null; };

/** What Botling Web (desktop/mobile/) puts in the same chrome: a control at the start of the chat's
 * header (the phone's bot list button) and the left column's foot in place of the desktop's add,
 * plugin and settings controls, which the web has no commands for. The desktop passes neither. */
export interface WebChrome { headerLead?: ReactNode; railFooter: ReactNode }

/** The main view of the main bot: the whiteboard tab unless you last picked Chat or Storage (kept for the next start). */
const CHOICE_KEY = "botling.mainWhiteboard";
export function useWhiteboardChoice(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(CHOICE_KEY) !== "0"; } catch { return true; } });
  const choose = useCallback((next: boolean) => {
    setOn(next);
    try { localStorage.setItem(CHOICE_KEY, next ? "1" : "0"); } catch { /* no storage: this session only */ }
  }, []);
  return [on, choose];
}
