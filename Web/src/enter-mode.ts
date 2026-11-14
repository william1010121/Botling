/**
 * What Return does in the chat box. With a physical keyboard (a desktop, an iPad's keyboard) Return sends and
 * Shift+Return is a new line. On a phone's on-screen keyboard Return is a new line and only the Send button sends:
 * there is no Shift+Return to type one, and a message of several lines would go out line by line.
 *
 * Decided by the device's input, not its user agent: a touch-only device (no hover, a coarse pointer, no fine pointer
 * anywhere: no mouse or trackpad) types on an on-screen keyboard until a physical keyboard shows itself. A physical
 * key names itself in `code` (KeyA, Digit1, an arrow, Tab, Escape); an on-screen keyboard's letters do not (iOS gives
 * an empty `code`, Android's input methods keyCode 229). An input method's Return is never a send either way (ime.ts).
 */

const PHYSICAL = /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Tab|Escape)$/;

/** No hover, a coarse pointer and no fine pointer anywhere: a phone (or a tablet without a trackpad). */
export function touchOnly(win: Window | undefined = typeof window === "undefined" ? undefined : window): boolean {
  const query = win?.matchMedia;
  if (typeof query !== "function") return false;
  try { return query.call(win, "(hover: none) and (pointer: coarse)").matches && !query.call(win, "(any-pointer: fine)").matches; }
  catch { return false; }
}

export class EnterMode {
  private physical = false;
  constructor(private readonly win: Window | undefined = typeof window === "undefined" ? undefined : window) {}

  /** Every key in the box: one only a physical keyboard sends switches Return to sending. */
  saw(event: KeyboardEvent): void {
    if (this.physical || event.isComposing || event.keyCode === 229) return;
    if (PHYSICAL.test(event.code ?? "") || ((event.metaKey || event.ctrlKey) && !!event.code)) this.physical = true;
  }

  /** Whether a plain Return sends (else it is a new line). */
  sends(): boolean { return this.physical || !touchOnly(this.win); }

  /** The on-screen keyboard's Return key label: "return" where it makes a new line. */
  hint(): "enter" | "send" { return touchOnly(this.win) ? "enter" : "send"; }
}
