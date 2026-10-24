import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, tempDir } from "../helpers";

export interface Launched { app: ElectronApplication; page: Page; dataDir: string }

export async function launch(options: { dataDir?: string; env?: Record<string, string>; chat?: unknown } = {}): Promise<Launched> {
  const dataDir = options.dataDir ?? tempDir("e2e");
  if (options.chat) {
    mkdirSync(join(dataDir, "core"), { recursive: true });
    writeFileSync(join(dataDir, "core", "chat.json"), JSON.stringify(options.chat, null, 2));
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  Object.assign(env, {
    BOTLING_DATA_DIR: dataDir, BOTLING_AGENT: "fake", BOTLING_HIDDEN: "1", BOTLING_QUIET: "1", BOTLING_QUIT_ON_CLOSE: "1",
    ...options.env,
  });
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [desktop], env, cwd: desktop });
  const page = await app.firstWindow();
  await page.waitForSelector('#messages[data-ready="1"]');
  return { app, page, dataDir };
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
