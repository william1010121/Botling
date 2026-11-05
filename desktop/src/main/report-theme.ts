// The look a report page is drawn in (Settings → Appearance → Report pages). A page that follows
// prefers-color-scheme gets the app's look (nativeTheme.themeSource, app-theme.ts); for any other look the
// page's <html> is marked data-theme, which Botling's report stylesheet (and any page that uses the same
// convention) honours over the colour scheme. "system" follows the app's look.

export const REPORT_THEMES = ["dark", "light", "system"] as const;
export type ReportTheme = (typeof REPORT_THEMES)[number];

/** The look to draw: the setting, or the app's look (`appDark`) for "system". */
export function resolveReportTheme(setting: ReportTheme | null | undefined, appDark: () => boolean): "dark" | "light" {
  if (setting === "light") return "light";
  if (setting === "system") return appDark() ? "dark" : "light";
  return "dark";
}

/** Whether the page must be marked: a light page always, a dark one only while the app is light. */
export function reportNeedsMark(theme: "dark" | "light", appDark: boolean): boolean {
  return theme === "light" || !appDark;
}

/** Mark the page's <html> with data-theme; a page that already chooses its theme, or has no <html> tag near the top, is left as it is. */
export function themeHtml(html: string, theme: "dark" | "light"): string {
  const tag = /<html\b[^>]*>/i.exec(html.slice(0, 8192));
  if (!tag || /\sdata-theme\s*=/i.test(tag[0])) return html;
  return `${html.slice(0, tag.index + 5)} data-theme="${theme}"${html.slice(tag.index + 5)}`;
}
