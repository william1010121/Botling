// The app page's report preview (App.tsx's ReportViewer), for what is not the chat itself: a plugin frame's
// `ccb.openLink` of a Markdown file (plugin-frame-host.ts). App registers the opener while it is up.
type Opener = (botId: string, url: string) => void;
let opener: Opener | null = null;

/** App's: shows `url` (a botling-card:// page) as bot `botId`'s report preview; returns the unregister. */
export function setReportOpener(next: Opener): () => void {
  opener = next;
  return () => { if (opener === next) opener = null; };
}

/** Shows a report preview; false when no page shows one. */
export function openReport(botId: string, url: string): boolean {
  if (!opener) return false;
  opener(botId, url);
  return true;
}
