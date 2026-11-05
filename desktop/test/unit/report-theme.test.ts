import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveReportTheme, themeHtml } from "../../src/main/report-theme";
import { previewResponse } from "../../src/main/preview-response";
import { applySetting, settingsView } from "../../src/core/settings";

let dir = "";
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "report-theme-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("resolves the report theme: dark by default, light on request, the system's look for system", () => {
  expect(resolveReportTheme(undefined, () => false)).toBe("dark");
  expect(resolveReportTheme("dark", () => false)).toBe("dark");
  expect(resolveReportTheme("light", () => true)).toBe("light");
  expect(resolveReportTheme("system", () => true)).toBe("dark");
  expect(resolveReportTheme("system", () => false)).toBe("light");
});

it("marks the page's <html> with data-theme and leaves pages that choose their own theme alone", () => {
  expect(themeHtml('<!doctype html><html lang="zh-Hant"><meta charset="utf-8">', "light")).toBe('<!doctype html><html data-theme="light" lang="zh-Hant"><meta charset="utf-8">');
  expect(themeHtml("<!DOCTYPE html>\n<HTML>", "light")).toBe('<!DOCTYPE html>\n<HTML data-theme="light">');
  expect(themeHtml('<html data-theme="dark"><body>', "light")).toBe('<html data-theme="dark"><body>');
  expect(themeHtml("<p>no html tag</p>", "light")).toBe("<p>no html tag</p>");
  expect(themeHtml("<htmlx><html>", "light")).toBe('<htmlx><html data-theme="light">');
});

it("serves a themed report page whole, with the preview policy, and other files untouched", async () => {
  const page = join(dir, "report.html"); writeFileSync(page, '<!doctype html><html lang="en"><p>報告</p>');
  const css = join(dir, "x.css"); writeFileSync(css, "p{}");
  const html = (text: string) => themeHtml(text, "light");
  const themed = await previewResponse(page, new Request("botling-card://preview/report.html", { headers: { range: "bytes=0-3" } }), { html });
  expect(themed.status).toBe(200);
  expect(await themed.text()).toBe('<!doctype html><html data-theme="light" lang="en"><p>報告</p>');
  expect(themed.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(themed.headers.get("content-security-policy")).toContain("sandbox");
  const plain = await previewResponse(page, new Request("botling-card://preview/report.html"));
  expect(await plain.text()).toBe('<!doctype html><html lang="en"><p>報告</p>');
  const style = await previewResponse(css, new Request("botling-card://preview/x.css"), { html });
  expect(await style.text()).toBe("p{}");
});

it("keeps the Appearance setting: dark is the default and is not written to settings.json", () => {
  expect(settingsView({}).reportTheme).toBe("dark");
  const light = applySetting({}, { key: "reportTheme", value: "light" });
  expect(light.reportTheme).toBe("light");
  expect(settingsView(light).reportTheme).toBe("light");
  expect(settingsView({ reportTheme: "sepia" }).reportTheme).toBe("dark");
  expect("reportTheme" in applySetting(light, { key: "reportTheme", value: "dark" })).toBe(false);
});
