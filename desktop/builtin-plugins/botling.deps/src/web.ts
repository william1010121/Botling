// botling.deps's one view, in the sandboxed frame the app page opens for it (opaque origin, no network): Settings → Plugin
// dependencies (`settings.section`). It reads through the program part (host.ts) and is sized to its content by the page around it.
import { h, render } from "preact";
import tokens from "../../../../Web/src/tokens.css";
import styles from "./deps.css";
import { DepBoardView } from "./DepBoardView";
import { frameSource } from "./source";

/** The part of the frame's `ccb` the view uses. */
export interface Ccb {
  panels: { register(id: string, render: (root: HTMLElement) => (() => void) | void): () => void };
  call(method: string, params?: unknown): Promise<unknown>;
}

export const BOARD_VIEW = "botling.deps.board";
export function activate(ccb: Ccb) {
  const source = frameSource(ccb);
  ccb.panels.register(BOARD_VIEW, (root) => {
    // The tokens and this plugin's styles go into the frame's page (it has none of its own).
    const style = document.createElement("style");
    style.textContent = `${tokens}\n${styles}`;
    document.head.append(style);
    render(h(DepBoardView, { source }) as never, root);
    return () => { render(null, root); style.remove(); };
  });
}
