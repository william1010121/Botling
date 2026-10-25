import {electronExecutable} from "../electron-runtime";
import { _electron as electron, type ElectronApplication, type Frame, type FrameLocator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, tempDir, until } from "../helpers";

export interface Launched { app: ElectronApplication; page: Page; chat: FrameLocator; dataDir: string }

/** The main bot's id (the Swift app's `Workspace.mainBotID`). */
export const MAIN = "6A0B0000-0000-4000-8000-000000000002";

export async function launch(options: { dataDir?: string; env?: Record<string, string>; chat?: unknown[]; importFrom?: string; waitForState?: boolean; args?: string[] } = {}): Promise<Launched> {
  const dataDir = options.dataDir ?? tempDir("e2e");
  if (options.chat) {
    // The main bot's chat, in the Swift app's chat.json format.
    mkdirSync(join(dataDir, "core", "main"), { recursive: true });
    writeFileSync(join(dataDir, "core", "main", "chat.json"), JSON.stringify(options.chat));
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  Object.assign(env, {
    BOTLING_DATA_DIR: dataDir, BOTLING_AGENT: "fake", BOTLING_HIDDEN: "1", BOTLING_QUIET: "1", BOTLING_QUIT_ON_CLOSE: "1",
    // A link a web AI's page opens outside the app is only noted, never handed to the real browser.
    BOTLING_NO_EXTERNAL: "1",
    // The page's own words in English whatever this computer's language (settings.json may name another).
    BOTLING_LANGUAGES: "en-US",
    ...(options.importFrom ? { BOTLING_IMPORT_FROM: options.importFrom } : {}),
    ...options.env,
  });
  delete env.ELECTRON_RUN_AS_NODE;
  if (!options.importFrom) delete env.BOTLING_IMPORT_FROM;
  const app = await electron.launch({ executablePath:electronExecutable(), args: [desktop,...(options.args??[])], env, cwd: desktop });
  const page = await app.firstWindow();
  const chat = page.frameLocator("#chat-frame");
  // A test of the first second types as soon as the input box is there (before any state).
  if (options.waitForState === false) return { app, page, chat, dataDir };
  await page.waitForSelector('.shell[data-ready="1"]');
  await chat.locator(".composer").waitFor();
  // The page has its first state (the chat a test means is the one shown).
  await chat.locator("html[data-chat]").waitFor({ state: "attached" });
  // Feature tests start after the initial welcome iframe has loaded and sized itself. Its load
  // can take native focus mid-keypress. Launch-race tests explicitly use waitForState:false.
  const welcome=chat.locator('[data-card="c-counter"] iframe');
  if(await welcome.count()){
    await chat.frameLocator('[data-card="c-counter"] iframe').locator('#n').waitFor();
    await until(async()=>await welcome.evaluate(el=>(el as HTMLIFrameElement).style.height!=='80px'),{what:'welcome card load/size handshake'});
  }
  return { app, page, chat, dataDir };
}

/** The chat frame itself (for evaluate). */
export function chatFrame(page: Page): Promise<Frame> {
  return until(() => page.frames().find((frame) => frame.url().endsWith("/chat.html")) ?? null, { what: "the chat frame" });
}

/** Types a message in the chat page's input box and sends it with Return. */
export async function say(chat: FrameLocator, text: string) {
  const box = chat.getByRole("textbox", { name: "Message" });
  // Typed once: words typed before the page's first state are kept (composer-race.spec.ts). Typed as
  // a person types, key by key (Shift-Return for a new line), then Return. Text put in at once
  // (Playwright's fill, insertText) was lost about one start in a hundred: as the window opens, a
  // card's frame in the chat loads (it posts its size) and focus leaves the input box for a moment;
  // text inserted then reached nothing, while keys are handed back to the box (chat-frame/entry.ts,
  // and since Phase 4c the app page passes on keys that land on it).
  await box.click();
  const keyboard = box.page().keyboard;
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (index > 0) await keyboard.press("Shift+Enter");
    if (line) await keyboard.type(line);
  }
  const actual=await box.evaluate(el=>[...el.querySelectorAll('.cm-line')].map(line=>line.textContent).join('\n'));
  if(actual!==text)throw new Error(`Native typing changed before send: expected ${JSON.stringify(text)}, received ${JSON.stringify(actual)}`);
  await keyboard.press("Enter");
}

/** Posts a raw envelope through the preload bridge and returns the response with that id. */
export function post(page: Page, envelope: Record<string, unknown>): Promise<any> {
  return page.evaluate((envelope) => new Promise((resolve) => {
    const bridge = (window as any).botling;
    const off = bridge.subscribe((message: any) => {
      if (message && message.id === envelope.id) { off(); resolve(message); }
    });
    bridge.post(envelope);
    setTimeout(() => { off(); resolve({ timeout: true }); }, 3_000);
  }), envelope);
}

export const audit = (app: ElectronApplication): Promise<string[]> => app.evaluate(() => (globalThis as any).__botlingAudit.slice());
