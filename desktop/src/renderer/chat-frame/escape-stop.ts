// Escape twice stops a reply being written, as in a terminal. One press was too easy to make by
// accident (closing a menu, leaving an edit), so the first press only says "press Esc again to stop"
// under the input box, and a second within ESCAPE_STOP_WINDOW_MS stops the reply. (There is no Stop
// button: a message sent while it writes never stops it, the bot hears it and carries on.)
//
// An Escape something else used does not count, and breaks a pair already started: one marked as
// handled (preventDefault), or one that came while a menu, list, dialog or lightbox was open (those
// close themselves on Escape, some without marking the key, so what was open is looked at before
// anything else sees the key).

export const ESCAPE_STOP_WINDOW_MS = 500;

const OVERLAYS = 'dialog[open], [role="menu"], [role="dialog"], [role="listbox"], .lightbox';

/** Whether a menu, list, dialog or lightbox is showing on the page (one an Escape would close). */
export function overlayOpen(root: ParentNode = document): boolean {
  for (const element of root.querySelectorAll<HTMLElement>(OVERLAYS)) {
    if (element.isConnected && !element.closest("[hidden]") && !(element instanceof HTMLDialogElement && !element.open)) return true;
  }
  return false;
}

export interface EscapeStopOptions {
  /** Whether a reply is being written now. */
  running(): boolean;
  stop(): void;
  /** The hint's words, in the page's language. */
  words(): string;
  now?: () => number;
}

/** Listens on this page's document; returns the function that stops listening and removes the hint. */
export function installEscapeStop(options: EscapeStopOptions): () => void {
  const now = options.now ?? (() => performance.now());
  let armedAt: number | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let hint: HTMLElement | null = null;
  // Escape key events that came while an overlay was open (looked at before any other listener).
  const used = new WeakSet<Event>();

  const hide = () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    hint?.classList.remove("shown");
  };
  const disarm = () => { armedAt = null; hide(); };
  const show = () => {
    if (!hint || !hint.isConnected) {
      hint = document.createElement("div");
      hint.className = "escape-stop-hint";
      hint.setAttribute("role", "status");
      hint.setAttribute("aria-live", "polite");
      document.body.append(hint);
    }
    hint.textContent = options.words();
    const composer = document.getElementById("composer-slot") ?? document.querySelector<HTMLElement>(".composer");
    const box = composer?.getBoundingClientRect();
    if (box && box.width > 0) {
      hint.style.left = `${box.left + box.width / 2}px`;
      hint.style.bottom = `${Math.max(4, window.innerHeight - box.bottom + 4)}px`;
    } else {
      hint.style.left = "50%";
      hint.style.bottom = "6px";
    }
    hint.classList.add("shown");
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(disarm, ESCAPE_STOP_WINDOW_MS);
  };

  const early = (event: KeyboardEvent) => { if (event.key === "Escape" && overlayOpen()) used.add(event); };
  const late = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (event.isComposing || event.repeat || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.defaultPrevented || used.has(event)) { disarm(); return; }
    if (!options.running()) { disarm(); return; }
    const at = now();
    if (armedAt !== null && at - armedAt <= ESCAPE_STOP_WINDOW_MS) {
      disarm();
      options.stop();
      return;
    }
    armedAt = at;
    show();
  };

  window.addEventListener("keydown", early, true);
  document.addEventListener("keydown", late);
  return () => {
    window.removeEventListener("keydown", early, true);
    document.removeEventListener("keydown", late);
    disarm();
    hint?.remove();
    hint = null;
  };
}
