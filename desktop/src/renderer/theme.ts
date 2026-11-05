// The page's look follows the app's (Settings → Appearance → App): main sets nativeTheme.themeSource,
// which is this page's prefers-color-scheme, and this marks <html data-theme> from it, live, so the
// design tokens (Web/src/tokens.css) and every `[data-theme="light"]` rule switch. Frames the page holds
// take their prefers-color-scheme from its color-scheme, which the stylesheets set from data-theme.

interface SchemeQuery { matches: boolean; addEventListener(type: "change", listener: () => void): void }

/** Mark `root` with data-theme from the colour scheme and keep it in step; returns the look now. */
export function followColorScheme(root: { dataset: DOMStringMap }, query: SchemeQuery | undefined): "dark" | "light" {
  const apply = () => { root.dataset.theme = query && !query.matches ? "light" : "dark"; };
  apply();
  query?.addEventListener("change", apply);
  return root.dataset.theme as "dark" | "light";
}

if (typeof document !== "undefined" && typeof matchMedia === "function") followColorScheme(document.documentElement, matchMedia("(prefers-color-scheme: dark)"));
