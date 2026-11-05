// The look a report page is drawn in (Settings → Appearance → Report pages). The app itself is always dark
// (nativeTheme.themeSource = "dark"), so a page that follows prefers-color-scheme would always be dark too;
// for a light look the page's <html> is marked data-theme="light", which Botling's report stylesheet (and
// any page that uses the same convention) honours over the colour scheme. Dark needs no change.

export const REPORT_THEMES = ["dark", "light", "system"] as const;
export type ReportTheme = (typeof REPORT_THEMES)[number];

/** The look to draw: the setting, or the system's appearance for "system". */
export function resolveReportTheme(setting: ReportTheme | null | undefined, systemDark: () => boolean): "dark" | "light" {
  if (setting === "light") return "light";
  if (setting === "system") return systemDark() ? "dark" : "light";
  return "dark";
}

/** Mark the page's <html> with data-theme; a page that already chooses its theme, or has no <html> tag near the top, is left as it is. */
export function themeHtml(html: string, theme: "dark" | "light"): string {
  const tag = /<html\b[^>]*>/i.exec(html.slice(0, 8192));
  if (!tag || /\sdata-theme\s*=/i.test(tag[0])) return html;
  return `${html.slice(0, tag.index + 5)} data-theme="${theme}"${html.slice(tag.index + 5)}`;
}
