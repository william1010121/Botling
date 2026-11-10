// The browser pane's floating toolbar (design v4, style 2): hidden while you read, it comes out when the pointer
// reaches the pane's top edge (the grip strip, or the page's own top edge as main reports it), stays while the
// pointer is on it, the URL bar has the focus (⌘L) or the site-tools sheet is open, and goes 1 s after the last of
// those ends. Kept apart from React so the timing can be tested.

export interface ToolbarTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: ToolbarTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const TOOLBAR_HIDE_MS = 1000;

export class ToolbarVisibility {
  private hovering = false;
  private urlFocused = false;
  private sheetOpen = false;
  private lingering = false;
  private timer: unknown = null;
  private shown = false;

  constructor(private readonly onChange: (visible: boolean) => void, private readonly timers: ToolbarTimers = realTimers, private readonly hideAfter = TOOLBAR_HIDE_MS) {}

  get visible(): boolean { return this.hovering || this.urlFocused || this.sheetOpen || this.lingering; }

  /** The pointer came onto the top strip or the toolbar. */
  enter(): void { this.hovering = true; this.stopTimer(); this.lingering = false; this.emit(); }
  /** The pointer left them. */
  leave(): void { if (!this.hovering) return; this.hovering = false; this.linger(); }
  /** The pointer touched the page's top edge (main): out now, and gone 1 s later unless the pointer comes onto it. */
  edge(): void { if (this.hovering) return; this.linger(); }
  /** ⌘L or a click in the URL bar (true), or it lost the focus (false). */
  focusUrl(on: boolean): void {
    if (this.urlFocused === on) return;
    this.urlFocused = on;
    if (on) this.emit(); else this.linger();
  }
  /** The site-tools sheet opened or closed. */
  sheet(on: boolean): void {
    if (this.sheetOpen === on) return;
    this.sheetOpen = on;
    if (on) this.emit(); else this.linger();
  }
  dispose(): void { this.stopTimer(); }

  private linger(): void {
    this.lingering = true;
    this.stopTimer();
    this.timer = this.timers.set(() => { this.timer = null; this.lingering = false; this.emit(); }, this.hideAfter);
    this.emit();
  }
  private stopTimer(): void {
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
  }
  private emit(): void {
    const next = this.visible;
    if (next === this.shown) return;
    this.shown = next;
    this.onChange(next);
  }
}
