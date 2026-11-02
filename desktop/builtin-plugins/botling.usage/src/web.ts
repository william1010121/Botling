// botling.usage's two views, each in the sandboxed frame the app page opens for it (opaque origin, no network): the
// quota rings of the sidebar gear's popover (`quickSettings`) and Settings → Usage (`settings.section`). A frame reads
// through the program part (host.ts); it is sized to its content by the page around it (`fit`).
import { h, render } from "preact";
import tokens from "../../../../Web/src/tokens.css";
import styles from "./usage.css";
import { QuickUsage } from "./QuickUsage";
import { SettingsUsage } from "./SettingsUsage";
import { frameSource } from "./source";

/** The part of the frame's `ccb` the views use. */
export interface Ccb {
  panels: { register(id: string, render: (root: HTMLElement) => (() => void) | void): () => void };
  call(method: string, params?: unknown): Promise<unknown>;
}

export const QUOTA_VIEW = "botling.usage.quota";
export const SETTINGS_VIEW = "botling.usage.settings";
export function activate(ccb: Ccb) {
  const source = frameSource(ccb);
  const view = (id: string, draw: () => unknown) => ccb.panels.register(id, (root) => {
    // The tokens and this plugin's styles go into the frame's page (it has none of its own).
    const style = document.createElement("style");
    style.textContent = `${tokens}\n${styles}`;
    document.head.append(style);
    render(draw() as never, root);
    return () => { render(null, root); style.remove(); };
  });
  view(QUOTA_VIEW, () => h(QuickUsage, { source }));
  view(SETTINGS_VIEW, () => h(SettingsUsage, { source }));
}
