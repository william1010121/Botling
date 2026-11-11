// @vitest-environment jsdom
import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isReportAction } from "../../src/renderer/chat-frame/report-action";
import { reportPreviewURL, shellReportNavigation } from "../../src/main/report-preview";
import { cardPreviewNavigation } from "../../src/main/card-page";

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
it("a preview card's frame loads its result page in the chat and in a plugin tab's card (the Note tab), only when the card page starts it", () => {
  type F = { url: string; parent: F | null };
  const app: F = { url: "app://botling/index.html", parent: null };
  const chat: F = { url: "botling-chat://chat/chat.html", parent: app };
  const kinds: Record<string, "panel" | "component"> = { NOTE: "panel", CARD: "component", CHATCARD: "component", OTHER: "panel" };
  const kind = (token: string) => kinds[token] ?? null;
  const isChat = (frame: F | null) => frame === chat;
  const chatCard: F = { url: "botling-card://page/CHATCARD", parent: chat };
  const note: F = { url: "botling-card://page/NOTE", parent: app };
  const noteCard: F = { url: "botling-card://page/CARD", parent: note };
  // The chat's card, as before.
  expect(cardPreviewNavigation(chatCard, chatCard, app, isChat, kind)).toBe(true);
  expect(cardPreviewNavigation(chatCard, null, app, isChat, kind)).toBe(true);
  // The Note tab: a card page inside the app-held panel page of a main tab (was refused: the frame stayed blank).
  expect(cardPreviewNavigation(noteCard, noteCard, app, isChat, kind)).toBe(true);
  expect(cardPreviewNavigation(noteCard, null, app, isChat, kind)).toBe(true);
  // Not started by the card page; the panel page itself; a card in a panel the app does not hold; a page main never served.
  expect(cardPreviewNavigation(noteCard, note, app, isChat, kind)).toBe(false);
  expect(cardPreviewNavigation(note, note, app, isChat, kind)).toBe(false);
  expect(cardPreviewNavigation({ url: "botling-card://page/CARD", parent: { url: "botling-card://page/NOTE", parent: noteCard } }, null, app, isChat, kind)).toBe(false);
  expect(cardPreviewNavigation({ url: "botling-card://page/XX", parent: note }, null, app, isChat, kind)).toBe(false);
  expect(cardPreviewNavigation({ url: "botling-card://page/OTHER", parent: note }, null, app, isChat, kind)).toBe(false);
  expect(cardPreviewNavigation(app, app, app, isChat, kind)).toBe(false);
  expect(cardPreviewNavigation(null, null, app, isChat, kind)).toBe(false);
});
