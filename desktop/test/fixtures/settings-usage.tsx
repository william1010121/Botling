// Isolated Settings renderer: fixture responses only, no Electron or user's data.
import { createRoot } from "react-dom/client";
import { SettingsSheet } from "../../src/renderer/Settings";
import type { Client } from "../../src/renderer/client";

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
const client = {
  request: async (cmd: { type: string }) => {
    if (cmd.type !== "usage.view") return null;
    window.usageRequests++;
    if (window.usagePending) return new Promise(() => {});
    if (window.usageFailure) throw new Error("synthetic backend failure with /private/raw.log");
    return window.usageFixture;
  },
} as unknown as Client;
createRoot(document.getElementById("root")!).render(<SettingsSheet client={client} settings={null} bot={null} plugins={null} onClose={() => {}} />);
