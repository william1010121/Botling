// botling.whiteboard's page, in the frame the app page opens for its main-area tab (a sandboxed frame: opaque
// origin, no network). `ccb` is the frame's own (panel-page.ts): calls to the program part (program.ts), the app's
// commands, tiles and approval asks. The page is drawn by ui.tsx, on Preact (see build.json).
import { h, render } from "preact";
import tokens from "../../../../Web/src/tokens.css";
import styles from "./board.css";
import type { BoardApi } from "./ui";
import { Whiteboard } from "./ui";
import type { BoardView } from "./types";

/** The part of the frame's `ccb` the board uses. */
export interface Ccb {
  panels: { register(id: string, render: (root: HTMLElement) => (() => void) | void): () => void };
  call(method: string, params?: unknown): Promise<unknown>;
  command(id: string, ...args: string[]): void;
  tile(spec: { component: string; data: unknown; size: string; botId: string }): Promise<string>;
  requestApproval(req: { botId: string; command: string; folder: string; card?: string }): Promise<{ allowed: boolean }>;
  notify(text: string): void;
}

/** The view id the manifest names (`contributes.views`). */
export const VIEW = "botling.whiteboard";

export function boardApi(ccb: Ccb): BoardApi {
  return {
    board: (since) => ccb.call("board", since === undefined ? {} : { since }) as Promise<BoardView>,
    ignore: async (botId, text) => { await ccb.call("ignore", { botId, text }); },
    send: async (text) => { await ccb.call("send", { text }); },
    openChat: (botId) => ccb.command("botling.openChat", botId),
    openResult: (botId, url) => ccb.command("botling.openResult", botId, url),
    tile: (spec) => ccb.tile(spec),
    approve: (req) => ccb.requestApproval(req),
    run: async (botId) => { await ccb.call("run", { botId }); },
    setShelf: (open) => { void ccb.call("shelf", { open }).catch(() => {}); },
    onError: (failure) => ccb.notify(String((failure as { message?: unknown } | null)?.message ?? failure).slice(0, 400)),
  };
}

export function activate(ccb: Ccb) {
  ccb.panels.register(VIEW, (root) => {
    // The tokens and the board's styles go into the frame's page (it has none of its own).
    const style = document.createElement("style");
    style.textContent = `${tokens}\n${styles}`;
    document.head.append(style);
    render(h(Whiteboard, { api: boardApi(ccb) }), root);
    return () => { render(null, root); style.remove(); };
  });
}
