// botling.git's views, each in the sandboxed frame the app page opens for it (opaque origin, no network): the Worktrees block
// of a bot's right panel (`rightPanel.section`) and the Worktrees page of Settings
// (`settings.section`). They ask this plugin's program part (host.ts) through the frame's `ccb`; the bot a view is about
// is `ccb.context.botId`.
import { h, render } from "preact";
import tokens from "../../../../Web/src/tokens.css";
import styles from "./git.css";
import { frameClient, type Ccb as ClientCcb } from "./client";
import { SettingsBlock, WorktreesBlock } from "./views";

export type Ccb = ClientCcb;

export const WORKTREES_VIEW = "botling.git.worktrees";
export const SETTINGS_VIEW = "botling.git.settings";
export function activate(ccb: Ccb) {
  const client = frameClient(ccb);
  const view = (id: string, draw: () => unknown) => ccb.panels.register(id, (root) => {
    // The tokens and this plugin's styles go into the frame's page (it has none of its own).
    const style = document.createElement("style");
    style.textContent = `${tokens}\n${styles}`;
    document.head.append(style);
    render(draw() as never, root);
    return () => { render(null, root); style.remove(); };
  });
  const botId = () => ccb.context?.botId ?? "";
  view(WORKTREES_VIEW, () => h(WorktreesBlock, { ccb, client, botId: botId() }));
  view(SETTINGS_VIEW, () => h(SettingsBlock, { ccb }));
}
