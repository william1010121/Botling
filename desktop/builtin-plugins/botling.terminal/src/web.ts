// botling.terminal's panel: the frame the page opens for each bot under the chat (`bottomPanel`). It draws the tabs (xterm.js) and talks
// to the program part (host.ts) through the one method "terminal"; what a shell prints comes back as the push "terminal"; the page
// tells it when it is shown ("visible") and when the toggle key ran ("toggle", which it answers with `ccb.panel.setVisible`).
import { h, render } from "preact";
import tokens from "../../../../Web/src/tokens.css";
import xtermCss from "@xterm/xterm/css/xterm.css";
import styles from "./terminal.css";
import { bridgeOf, fontIsLoading, TerminalPanel, type PanelCcb } from "./panel";

export const PANEL_VIEW = "botling.terminal.panel";

/** The font comes from the program part (a frame has no files of its own) and is added to the frame's document. */
async function loadFont(ccb: PanelCcb) {
  const answer = await bridgeOf(ccb).request({ type: "font" }) as { font: string };
  const bytes = Uint8Array.from(atob(answer.font), (char) => char.charCodeAt(0));
  const face = new FontFace("Botling Terminal", bytes.buffer);
  await face.load();
  document.fonts.add(face);
}

export function activate(ccb: PanelCcb) {
  ccb.panels.register(PANEL_VIEW, (root) => {
    // The tokens and this plugin's styles go into the frame's page (it has none of its own).
    const style = document.createElement("style");
    style.textContent = `${tokens}\n${xtermCss}\n${styles}`;
    document.head.append(style);
    fontIsLoading(loadFont(ccb));
    render(h(TerminalPanel, { ccb, botId: ccb.context?.botId ?? "" }), root);
    return () => { render(null, root); style.remove(); };
  });
}
