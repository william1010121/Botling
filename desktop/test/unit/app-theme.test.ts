import { expect, it } from "vitest";
import { themeSourceFor, windowBackground } from "../../src/main/app-theme";
import { reportNeedsMark, resolveReportTheme } from "../../src/main/report-theme";
import { applySetting, settingsView } from "../../src/core/settings";
import { SettingsChange, SettingsView } from "../../src/contract";
import { followColorScheme } from "../../src/renderer/theme";
import { panelPage, PANEL_THEME_SCRIPT } from "../../src/renderer/panel-page";

it("keeps the app's look: dark by default, light and the system's look on request, dropped back to dark", () => {
  expect(settingsView({}).appTheme).toBe("dark");
  const light = applySetting({}, { key: "appTheme", value: "light" });
  expect(light.appTheme).toBe("light");
  expect(settingsView(light).appTheme).toBe("light");
  expect(settingsView(applySetting(light, { key: "appTheme", value: "system" })).appTheme).toBe("system");
  expect("appTheme" in applySetting(light, { key: "appTheme", value: "dark" })).toBe(false);
  expect(settingsView({ appTheme: "sepia" }).appTheme).toBe("dark");
  // The app theme and the report theme are separate settings.
  expect(settingsView(light).reportTheme).toBe("dark");
});

it("takes appTheme in the contract, and only its three looks", () => {
  expect(SettingsChange.safeParse({ key: "appTheme", value: "light" }).success).toBe(true);
  expect(SettingsChange.safeParse({ key: "appTheme", value: "sepia" }).success).toBe(false);
  expect(SettingsView.shape.appTheme.parse(undefined)).toBe("dark");
});

it("maps the setting onto nativeTheme.themeSource and the window background", () => {
  expect(themeSourceFor("dark")).toBe("dark");
  expect(themeSourceFor("light")).toBe("light");
  expect(themeSourceFor("system")).toBe("system");
  expect(themeSourceFor(undefined)).toBe("dark");
  expect(themeSourceFor(null)).toBe("dark");
  expect(windowBackground(true)).toBe("#0E0E10");
  expect(windowBackground(false)).toBe("#F5F5F7");
});

it("draws reports in the app's look for Match app, and marks a dark report while the app is light", () => {
  expect(resolveReportTheme("system", () => false)).toBe("light");
  expect(resolveReportTheme("system", () => true)).toBe("dark");
  expect(resolveReportTheme("dark", () => false)).toBe("dark");
  expect(reportNeedsMark("light", true)).toBe(true);
  expect(reportNeedsMark("dark", true)).toBe(false);
  expect(reportNeedsMark("dark", false)).toBe(true);
});

it("marks <html data-theme> from the colour scheme and follows it live", () => {
  const listeners: (() => void)[] = [];
  const query = { matches: true, addEventListener: (_: "change", listener: () => void) => { listeners.push(listener); } };
  const root = { dataset: {} as DOMStringMap };
  expect(followColorScheme(root, query)).toBe("dark");
  expect(root.dataset.theme).toBe("dark");
  query.matches = false;
  for (const listener of listeners) listener();
  expect(root.dataset.theme).toBe("light");
  expect(followColorScheme({ dataset: {} as DOMStringMap }, undefined)).toBe("dark");
});

it("gives plugin panel pages the theme signal before anything draws, with a light look", () => {
  const page = panelPage("meter", "meter.rings", "export const activate = () => {}", {});
  expect(page).toContain('data-theme="dark"');
  expect(page.indexOf(PANEL_THEME_SCRIPT)).toBeGreaterThan(-1);
  expect(page.indexOf(PANEL_THEME_SCRIPT)).toBeLessThan(page.indexOf("<style>"));
  expect(page).toContain(':root[data-theme="light"] { color-scheme: light; }');
  expect(page).toContain("background: #FFFFFF;");
  expect(panelPage("meter", "meter.rings", "", {}, { fontSize: 13 })).not.toContain("background: #FFFFFF;");
});
