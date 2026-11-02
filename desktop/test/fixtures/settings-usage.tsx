// Isolated Settings → Usage (botling.usage's page): fixture responses only, no Electron or user's data.
import { createRoot } from "react-dom/client";
import { SettingsUsage } from "../../builtin-plugins/botling.usage/src/SettingsUsage";
import type { UsageSource } from "../../builtin-plugins/botling.usage/src/usage-session";

declare global {
  interface Window {
    usageFixture: unknown;
    usageFailure: boolean;
    usagePending: boolean;
    usageRequests: number;
    usageRefresh: (() => void) | undefined;
  }
}
const interval = window.setInterval.bind(window);
window.setInterval = ((callback: () => void, ms: number) => {
  if (ms === 60_000) window.usageRefresh = callback;
  return interval(callback, ms);
}) as typeof window.setInterval;
const source: UsageSource = {
  view: async () => {
    window.usageRequests++;
    if (window.usagePending) return new Promise(() => {});
    if (window.usageFailure) throw new Error("synthetic backend failure with /private/raw.log");
    return window.usageFixture as never;
  },
  onTurnFinished: () => () => {},
};
// The page's own frame around it, as Settings has it (the plugin's frame draws only the body).
createRoot(document.getElementById("root")!).render(<div className="settings"><section className="settings-main"><div className="settings-body"><SettingsUsage source={source} /></div></section></div>);
