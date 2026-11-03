// botling.routines' view, in the sandboxed frame the chat header's popover opens for the bot on screen (opaque origin, no
// network). It reads through the program part (host.ts); the bot is `ccb.context.botId`.
import { h, render } from "preact";
import tokens from "../../../../Web/src/tokens.css";
import styles from "./routines.css";
import { RoutinesPanel } from "./RoutinesPanel";
import { frameSource } from "./source";

/** The part of the frame's `ccb` the view uses. */
export interface Ccb {
  panels: { register(id: string, render: (root: HTMLElement) => (() => void) | void): () => void };
  call(method: string, params?: unknown): Promise<unknown>;
  context?: { botId?: string };
}

export const PANEL_VIEW = "botling.routines.panel";

export function activate(ccb: Ccb) {
  ccb.panels.register(PANEL_VIEW, (root) => {
    const style = document.createElement("style");
    style.textContent = `${tokens}\n${styles}`;
    document.head.append(style);
    render(h(RoutinesPanel, { source: frameSource(ccb, ccb.context?.botId ?? "") }) as never, root);
    return () => { render(null, root); style.remove(); };
  });
}
