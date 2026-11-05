// The whole app's look (Settings → Appearance → App). Electron's nativeTheme.themeSource drives
// prefers-color-scheme in every page and frame of the app, the window's own chrome and native menus;
// the app page and the chat page then mark their <html> data-theme from it (renderer/theme.ts), which
// switches the design tokens (Web/src/tokens.css) to their light set.

export const APP_THEMES = ["dark", "light", "system"] as const;
export type AppTheme = (typeof APP_THEMES)[number];

/** nativeTheme.themeSource for the setting: dark unless light or the system's look is chosen. */
export function themeSourceFor(setting: AppTheme | null | undefined): "dark" | "light" | "system" {
  return setting === "light" || setting === "system" ? setting : "dark";
}

/** The window's background before its page draws (the tokens' --ground). */
export function windowBackground(dark: boolean): string {
  return dark ? "#0E0E10" : "#F5F5F7";
}
