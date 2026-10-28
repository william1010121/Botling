import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { launch } from "./launch";
import { tempDir, until, swiftLine } from "../helpers";

test("preview full page stays in the main window; return preserves chat and ordinary links", async () => {
  test.setTimeout(60_000);
  const project = tempDir("report-viewer"); const artifacts = join(project, "artifacts"); mkdirSync(artifacts);
  const file = join(artifacts, "report.html"); const url = pathToFileURL(file).href;
  writeFileSync(join(artifacts, "dot.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="blue"/></svg>');
  writeFileSync(file, '<!doctype html><meta charset="utf-8"><h1>Embedded report</h1><img src="dot.svg"><p id="script"></p><script>document.querySelector("#script").textContent="Script works"</script>');
  const {app} = await launch({waitForState:false,chat:[swiftLine({id:"11111111-1111-4111-8111-111111111111",role:"bot",text:`${"Earlier conversation.\n\n".repeat(35)}[Report](${url})\n\n[Ordinary web](https://example.org/report)`})],env:{BOTLING_HIDDEN:"1"}});
  try {
    const shell = await until(() => app.context().pages().find(p => p.url() === "app://botling/index.html"));
    const editor = await until(() => app.context().pages().find(p => p.url().includes("nativeHost=1")));
    await shell.locator('.shell[data-ready="1"]').waitFor();
    if (await shell.locator(".chat-column.whiteboard-on").count()) await shell.getByRole("button", {name:"Chat",exact:true}).click();
    const component = editor.frameLocator('.page-preview iframe').first();
    await component.getByRole('button', {name:'開啟完整頁面',exact:true}).waitFor();
    await editor.evaluate(() => { (window as any).reportChatMarker = 42; });
    const cdp = await editor.context().newCDPSession(editor);
    await cdp.send("Emulation.setFocusEmulationEnabled", {enabled:true});
    await editor.locator('.composer .cm-content').evaluate((el: HTMLElement) => el.focus());
    await cdp.send('Input.insertText', {text:'keep this draft'});
    await component.getByRole('button', {name:'開啟完整頁面',exact:true}).scrollIntoViewIfNeeded();
    const scroll = await editor.locator('#scroller').evaluate(el => el.scrollTop);
    expect(scroll).toBeGreaterThan(0);
    const windows = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().length);
    await component.getByRole('button', {name:'開啟完整頁面',exact:true}).click();
    const viewer = shell.getByRole('dialog', {name:'Report preview'});
    await expect(viewer).toBeVisible();
    const report = shell.frameLocator('iframe[title="Full page report"]');
    await expect(report.locator('h1')).toHaveText('Embedded report');
    await expect(report.locator('#script')).toHaveText('Script works');
    await expect.poll(() => report.locator('img').evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    expect(await report.locator('body').evaluate(() => typeof (window as any).botling)).toBe('undefined');
    expect(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().length)).toBe(windows);
    await shell.screenshot({path:join(project,'embedded.png')});
    await viewer.getByRole('button',{name:'Back to conversation',exact:false}).click();
    await expect(viewer).toHaveCount(0);
    expect(await editor.evaluate(() => (window as any).reportChatMarker)).toBe(42);
    await expect(editor.locator('.composer .cm-content')).toHaveText('keep this draft');
    expect(await editor.locator('#scroller').evaluate(el => el.scrollTop)).toBe(scroll);
    // Real ordinary link chips keep the existing external route, even for this same HTML report.
    await editor.locator('[data-url]').filter({hasText:'Ordinary web'}).first().click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).__botlingOpenedResults)).toContain('https://example.org/report');
    await editor.locator('[data-url]').filter({hasText:'Report'}).first().click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).__botlingOpenedResults)).toContain(url);
    await expect(viewer).toHaveCount(0);
    expect(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().some(w => w.isVisible()))).toBe(false);
    console.log('Report viewer screenshot:', join(project,'embedded.png'));
  } finally { await app.close(); }
});
