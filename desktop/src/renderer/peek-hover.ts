// When a bot's status card (PeekCard) opens and closes: on hover, after a short delay so sweeping the pointer over
// the list does not flash cards; kept open while the pointer crosses from the row into the card (a short grace);
// closed once it has left both. Keyboard focus on a row opens it at once. One card at a time. Pure timing (no DOM).

export const PEEK_OPEN_DELAY_MS = 250;
export const PEEK_CLOSE_GRACE_MS = 150;

export type PeekAnchor = { top: number; right: number };

export type PeekHover = {
  /** The pointer came onto a bot's row (one with something to show): its card opens after the delay. */
  enterRow: (botId: string, anchor: () => PeekAnchor) => void;
  /** The pointer left the row: a pending open is dropped; an open card closes after the grace. */
  leaveRow: () => void;
  /** The pointer came into the open card: it stays. */
  enterCard: () => void;
  /** The pointer left the card: it closes after the grace (unless it comes back to the card or its row). */
  leaveCard: () => void;
  /** Open now (keyboard focus on a row, or a tap where nothing hovers). */
  openNow: (botId: string, anchor: PeekAnchor) => void;
  /** Close now (Escape, an outside click, the window losing focus) and drop anything pending. */
  close: () => void;
  /** The bot whose card is open, if any. */
  shown: () => string | null;
  dispose: () => void;
};

export function peekHover({ onOpen, onClose, openDelay = PEEK_OPEN_DELAY_MS, closeGrace = PEEK_CLOSE_GRACE_MS }: {
  onOpen: (botId: string, anchor: PeekAnchor) => void;
  onClose: () => void;
  openDelay?: number;
  closeGrace?: number;
}): PeekHover {
  let open: string | null = null;
  let opening: ReturnType<typeof setTimeout> | null = null;
  let closing: ReturnType<typeof setTimeout> | null = null;
  const stopOpening = () => { if (opening) { clearTimeout(opening); opening = null; } };
  const stopClosing = () => { if (closing) { clearTimeout(closing); closing = null; } };
  const show = (botId: string, anchor: PeekAnchor) => { stopOpening(); stopClosing(); open = botId; onOpen(botId, anchor); };
  const hide = () => { stopOpening(); stopClosing(); if (open !== null) { open = null; onClose(); } };
  const closeSoon = () => { stopClosing(); if (open !== null) closing = setTimeout(hide, closeGrace); };
  return {
    enterRow(botId, anchor) {
      stopOpening();
      if (open === botId) { stopClosing(); return; }
      // Another bot's card stays while this one's delay runs (no gap, no flash), then is switched for it.
      stopClosing();
      opening = setTimeout(() => { opening = null; show(botId, anchor()); }, openDelay);
    },
    leaveRow() { stopOpening(); closeSoon(); },
    enterCard() { stopClosing(); },
    leaveCard() { closeSoon(); },
    openNow(botId, anchor) { if (open === botId) { stopOpening(); stopClosing(); return; } show(botId, anchor); },
    close: hide,
    shown: () => open,
    dispose() { stopOpening(); stopClosing(); },
  };
}
