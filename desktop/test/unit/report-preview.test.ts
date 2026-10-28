// @vitest-environment jsdom
import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isReportAction } from "../../src/renderer/chat-frame/report-action";
import { reportPreviewURL, shellReportNavigation } from "../../src/main/report-preview";

it("only the preview card's own page action selects the embedded route", () => {
  const frame = document.createElement("iframe") as HTMLIFrameElement & {ccbData: string};
  frame.setAttribute("aria-label", "網頁預覽卡片");
  const url = "file:///project/artifacts/report.html";
  frame.ccbData = JSON.stringify({url, src: "botling-card://preview/project/artifacts/report.html"});
  expect(isReportAction(frame, {type: "openURL", url})).toBe(true);
  expect(isReportAction(null, {type: "openURL", url})).toBe(false);
  expect(isReportAction(frame, {type: "openURL", url: "https://example.org"})).toBe(false);
  expect(isReportAction(frame, {type: "revealFile", url})).toBe(false);
  frame.setAttribute("aria-label", "Other card");
  expect(isReportAction(frame, {type: "openURL", url})).toBe(false);
});
it("serves only existing artifact HTML, including encoded paths, and refuses symlink escapes", () => {
  const dir = mkdtempSync(join(tmpdir(), "report-preview-"));
  try {
    const artifacts = join(dir, "artifacts"); mkdirSync(artifacts);
    const file = join(artifacts, "報告 #1.html"); writeFileSync(file, "<!doctype html>");
    expect(reportPreviewURL(pathToFileURL(file).href)).toContain("%23");
    const outside = join(dir, "private.html"); writeFileSync(outside, "private");
    symlinkSync(outside, join(artifacts, "escape.html"));
    for (const path of [outside, join(artifacts, "escape.html"), join(artifacts, "missing.html"), "https://example.org/report.html"]) expect(() => reportPreviewURL(path)).toThrow();
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
it("only the shell can initiate its viewer frame navigation", () => {
  const shell = {}, report = {}, card = {};
  expect(shellReportNavigation(shell, shell, shell)).toBe(true);
  expect(shellReportNavigation(shell, null, shell)).toBe(true);
  expect(shellReportNavigation(shell, report, shell)).toBe(false);
  expect(shellReportNavigation(card, card, shell)).toBe(false);
});
