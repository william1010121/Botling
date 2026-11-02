import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch, showChat } from "../test/e2e/launch";
import { until } from "../test/helpers";

const repoRoot = resolve(__dirname, "../..");
const screensDir = join(repoRoot, "specs/screens");
const flowHtmlPath = join(repoRoot, "specs/flow.html");

async function captureWindow(app: any, filename: string) {
  const dataUrl = await app.evaluate(async () => {
    const fn = (globalThis as unknown as { __botlingWindowPicture: () => Promise<string | null> }).__botlingWindowPicture;
    return fn ? await fn() : null;
  });
  if (!dataUrl) throw new Error("Failed to capture window picture from __botlingWindowPicture");
  const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
  writeFileSync(join(screensDir, filename), Buffer.from(base64Data, "base64"));
}

test.describe("Wireflow Automated Screenshot Pipeline & Verification", () => {
  test.beforeAll(() => {
    mkdirSync(screensDir, { recursive: true });
  });

  test("Capture S4: Whiteboard Grid State (白板多維磁貼視圖)", async () => {
    test.setTimeout(45_000);
    const { app } = await launch({ waitForState: false });
    try {
      const shellPage = await until(() => app.context().pages().find(p => p.url() === "app://botling/index.html"), { what: "shell page" });
      await shellPage.waitForSelector('.shell[data-ready="1"]');
      await shellPage.waitForTimeout(400);
      await captureWindow(app, "S4.png");
      expect(existsSync(join(screensDir, "S4.png"))).toBe(true);
    } finally {
      await app.close();
    }
  });

  test("Capture S5: Sidebar Settings State (側邊欄快速設定面板)", async () => {
    test.setTimeout(45_000);
    const { app } = await launch({ waitForState: false });
    try {
      const shellPage = await until(() => app.context().pages().find(p => p.url() === "app://botling/index.html"), { what: "shell page" });
      await shellPage.waitForSelector('.shell[data-ready="1"]');
      const gear = shellPage.getByRole("button", { name: "Quick settings", exact: true });
      if (await gear.count() > 0) {
        await gear.click();
        await shellPage.waitForTimeout(300);
      }
      await captureWindow(app, "S5.png");
      expect(existsSync(join(screensDir, "S5.png"))).toBe(true);
    } finally {
      await app.close();
    }
  });

  test("Capture S1, S2, E1, M1: Chat states (初始、串流、中斷與沙箱卡片)", async () => {
    test.setTimeout(60_000);
    const { app } = await launch({ waitForState: false, env: { FAKE_CLAUDE_MODE: "slow" } });
    try {
      const shellPage = await until(() => app.context().pages().find(p => p.url() === "app://botling/index.html"), { what: "shell page" });
      await shellPage.waitForSelector('.shell[data-ready="1"]');
      await showChat(shellPage);

      const editor = await until(() => app.context().pages().find(p => p.url().includes("nativeHost=1")), { what: "native editor page" });
      await editor.locator('html[data-chat]').waitFor({ state: 'attached' });
      await until(async () => (await editor.locator(".row[data-id]").count()) > 0, { what: "chat rows ready" });

      // S1: Welcome and Idle State
      await captureWindow(app, "S1.png");
      expect(existsSync(join(screensDir, "S1.png"))).toBe(true);

      // M1: Sandboxed counter card in chat
      const cardEl = editor.locator('[data-card="c-counter"]');
      if (await cardEl.count() > 0) {
        await cardEl.first().screenshot({ path: join(screensDir, "M1.png") });
      } else {
        await captureWindow(app, "M1.png");
      }
      expect(existsSync(join(screensDir, "M1.png"))).toBe(true);

      // S2: Active Streaming Turn State
      const cm = editor.locator('.cm-content');
      await cm.click();
      await editor.keyboard.type("請說明 Wireflow 狀態機規格");
      await editor.keyboard.press("Enter");
      await editor.waitForTimeout(600);
      await captureWindow(app, "S2.png");
      expect(existsSync(join(screensDir, "S2.png"))).toBe(true);

      // E1: Engine Interrupted / Error State
      await editor.keyboard.press("Escape");
      await editor.waitForTimeout(400);
      await captureWindow(app, "E1.png");
      expect(existsSync(join(screensDir, "E1.png"))).toBe(true);
    } finally {
      await app.close();
    }
  });

  test("Capture S3, S6: Chat completed & Subagent task states", async () => {
    test.setTimeout(45_000);
    const { app } = await launch({ waitForState: false });
    try {
      const shellPage = await until(() => app.context().pages().find(p => p.url() === "app://botling/index.html"), { what: "shell page" });
      await shellPage.waitForSelector('.shell[data-ready="1"]');
      await showChat(shellPage);

      const editor = await until(() => app.context().pages().find(p => p.url().includes("nativeHost=1")), { what: "native editor page" });
      await editor.locator('html[data-chat]').waitFor({ state: 'attached' });

      // S3: Completed Turn State
      const cm = editor.locator('.cm-content');
      await cm.click();
      await editor.keyboard.type("總結系統架構");
      await editor.keyboard.press("Enter");
      await until(async () => (await editor.locator('.row.bot[data-state="done"]').count()) > 0, { what: "turn 1 done" });
      await captureWindow(app, "S3.png");
      expect(existsSync(join(screensDir, "S3.png"))).toBe(true);

      // S6: Subagent Execution State
      await cm.click();
      await editor.keyboard.type("派發子代理建立規格文件");
      await editor.keyboard.press("Enter");
      await until(async () => (await editor.locator('.row.bot[data-state="done"]').count()) > 1, { what: "second reply" });
      await captureWindow(app, "S6.png");
      expect(existsSync(join(screensDir, "S6.png"))).toBe(true);
    } finally {
      await app.close();
    }
  });

  test("Validate specs/flow.html integrity and contract compliance", () => {
    expect(existsSync(flowHtmlPath)).toBe(true);
    const html = readFileSync(flowHtmlPath, "utf8");

    // All required State IDs are covered
    const requiredStates = ["S1", "S2", "S3", "S4", "S5", "S6", "M1", "E1", "E2", "E3"];
    for (const id of requiredStates) {
      expect(html).toContain(`data-id="${id}"`);
    }

    // Required status tags
    expect(html).toContain("已實作");
    expect(html).toContain("已設計");
    expect(html).toContain("未做");

    // Red border styling for error states
    expect(html).toContain("is-error");
    expect(html).toContain("--danger");

    // Fallback wireframe placeholders
    for (const id of requiredStates) {
      expect(html).toContain(`fallback-${id}`);
    }

    // Verify all 8 captured screenshots exist and have valid PNG signatures
    const captured = ["S1.png", "S2.png", "S3.png", "S4.png", "S5.png", "S6.png", "E1.png", "M1.png"];
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const file of captured) {
      const p = join(screensDir, file);
      expect(existsSync(p)).toBe(true);
      const buf = readFileSync(p);
      expect(buf.subarray(0, 8).equals(pngMagic)).toBe(true);
    }
  });
});
