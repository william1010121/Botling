// M2 step 8 harness: a real botlingd (out/server/main.cjs, fake engine, temp data folder) with its loopback listener on
// a fixed free port, `botlingd pair` driven through its stdin, and the built page (web-v3/dist) in headless Chromium /
// WebKit from the Playwright browsers already installed (nothing downloaded, no window, 127.0.0.1 only).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import type { BrowserContext, BrowserType, FrameLocator, Page } from "@playwright/test";
import { BotlingdProcess, botlingdEnv, botlingdScript, MAIN, ScriptClient } from "../../botlingd-harness";
import { until } from "../../helpers";
import type { MessageView } from "../../../src/contract";
import { assertPageFresh } from "./page-fresh";

// Every page test imports this harness: refuse a web-v3/dist older than its sources before any test runs.
assertPageFresh();

export { MAIN };

/** A free loopback port (bound and released), so a restarted botlingd listens on the same origin. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export class Server {
  daemon: BotlingdProcess;
  /** `script`: a copy of the built server beside a page of its own (the shell-alone check); default out/server/main.cjs. */
  constructor(readonly dataDir: string, readonly port: number, readonly extra: Record<string, string> = {}, readonly script?: string) { this.daemon = this.spawn(); }
  private spawn(): BotlingdProcess { return new BotlingdProcess(this.dataDir, { ...this.extra, BOTLING_SERVER_PORT: String(this.port) }, this.script); }
  get origin(): string { return `http://127.0.0.1:${this.port}`; }
  get page(): string { return `${this.origin}/v3/`; }
  async ready(): Promise<void> {
    await this.daemon.ready();
    await until(() => this.daemon.log.includes(`listener: http://127.0.0.1:${this.port}`) || this.daemon.log.includes("listener:"), { timeout: 20_000, what: "the listener" });
    if (!this.daemon.log.includes(`127.0.0.1:${this.port}`)) throw new Error(`botlingd is not listening on ${this.port}:\n${this.daemon.log.slice(-2_000)}`);
  }
  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<number | null> { return this.daemon.stop(signal); }
  async restart(): Promise<void> { this.daemon = this.spawn(); await this.ready(); }

  /** The chat as the server holds it (a local front end's `chat.snapshot` over the Unix socket). */
  async messages(botId = MAIN): Promise<MessageView[]> {
    const client = new ScriptClient(`check-${Date.now()}`);
    await client.connect(this.daemon.socket, this.daemon.token);
    try {
      const res = await client.req({ type: "chat.snapshot", botId });
      const result = (res as unknown as { result?: { chat?: { messages: MessageView[] } } }).result;
      return result?.chat?.messages ?? [];
    } finally { client.close(); }
  }
}

/** `botlingd pair` with a pipe for its stdin; the first pairing types the recovery code back. */
export class PairCli {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: string[] = [];
  stderr = "";
  readonly closed: Promise<number | null>;
  constructor(dataDir: string) {
    this.child = spawn(process.execPath, ["--no-warnings", botlingdScript, "pair", "--no-qr", "--name", "Test phone"], { env: botlingdEnv(dataDir), stdio: "pipe" });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.lines.push(line));
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.closed = new Promise((resolve) => this.child.once("close", (code) => resolve(code)));
  }
  line(test: (line: string) => boolean, what: string, from = 0, timeout = 30_000): Promise<string> {
    return until(() => {
      const found = this.lines.slice(from).find(test);
      if (!found && this.child.exitCode !== null) throw new Error(`botlingd pair exited ${this.child.exitCode} before ${what}\n${this.lines.join("\n")}\n${this.stderr}`);
      return found;
    }, { timeout, what });
  }
  type(text: string): void { this.child.stdin.write(`${text}\n`); }
  /** Prints the link (after the recovery code on a first pairing). */
  async link(): Promise<string> {
    const first = await until(() => this.lines.find((l) => l.startsWith("https://") || /^\s+([A-Z2-7]{4}-){6}[A-Z2-7]{2}$/.test(l)), { timeout: 30_000, what: "the link or the recovery code" });
    if (!first.startsWith("https://")) {
      await this.line((l) => l.startsWith("Press Enter"), "the saved-it prompt");
      this.type("");
    }
    return this.line((l) => l.startsWith("https://"), "the pairing link");
  }
}

export const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BOTLING_"))) as Record<string, string>;

/** A phone-width headless context (a persistent profile, so IndexedDB outlives a page reload and a context restart). */
export async function phone(type: BrowserType, profile: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await type.launchPersistentContext(profile, { headless: true, env: cleanEnv(), viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "dark" });
  const page = context.pages()[0] ?? await context.newPage();
  return { context, page };
}

export const chatOf = (page: Page): FrameLocator => page.frameLocator("iframe[src*='/v3/chat.html']");

/** The chat page's text box: types like a person, then Return (test/e2e/launch.ts `say`). */
export async function say(page: Page, text: string): Promise<void> {
  const box = chatOf(page).getByRole("textbox", { name: "Message" });
  await box.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

export interface Diag { live: number[]; states: Record<string, string[]>; conn: string[]; frames: number; ends: string[] }
export const diag = (page: Page): Promise<Diag> => page.evaluate(() => JSON.parse(JSON.stringify((globalThis as { botling3Diagnostics?: unknown }).botling3Diagnostics)) as Diag);

/** Rows of the chat page whose text contains `text`. */
export async function rowsWith(page: Page, text: string): Promise<number> {
  return chatOf(page).locator("#messages .row").filter({ hasText: text }).count();
}
