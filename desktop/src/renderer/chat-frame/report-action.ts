/** Only the preview card's own full-page action; ordinary links keep their route. */
export function isReportAction(frame: HTMLIFrameElement | null | undefined, action: {type?: unknown; url?: unknown} | null): boolean {
  if (!frame || action?.type !== "openURL" || frame.getAttribute("aria-label") !== "網頁預覽卡片") return false;
  try {
    const data = JSON.parse((frame as HTMLIFrameElement & {ccbData?: string}).ccbData ?? "null");
    return typeof data?.url === "string" && data.url === action.url && typeof data.src === "string" && data.src.startsWith("botling-card://preview/");
  } catch { return false; }
}
