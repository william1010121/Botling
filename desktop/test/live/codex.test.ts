// The Codex head against the real `codex app-server` (codex-cli 0.163.0), and a real two-head
// claim (real claude + real Codex). Opt-in: BOTLING_LIVE_CODEX=1 (`npm run test:live`); three short
// turns in all. Codex runs with a throwaway CODEX_HOME holding only a copy of the user's auth.json
// (deleted afterwards), so the user's own ~/.codex (config, sessions, history) is not read or
// written; the bot's folder is a throwaway one. Claude runs in harmless mode (no tools, no MCP,
// no CLAUDE.md, no saved session).
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

const live = process.env.BOTLING_LIVE_CODEX === "1";
const harnesses: CoreHarness[] = [];
let codexHome: string | null = null;
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGTERM");
});
afterAll(() => { if (codexHome) rmSync(codexHome, { recursive: true, force: true }); });

function home(): string {
  if (codexHome) return codexHome;
  const base = process.env.TMPDIR && process.env.TMPDIR.startsWith("/Volumes/") ? process.env.TMPDIR : tempDir("codex-home-base");
  codexHome = mkdtempSync(join(base, "codex-home-"));
  copyFileSync(join(homedir(), ".codex", "auth.json"), join(codexHome, "auth.json"));
  return codexHome;
}

function core(engines: string[]) {
  const dir = tempDir("live-codex");
  mkdirSync(join(dir, "main"), { recursive: true });
  writeFileSync(join(dir, "main", "bot.json"), JSON.stringify({ engine: engines[0], heads: { engines, answerWith: engines.length > 1 ? "both" : engines[0] } }));
  const c = new CoreHarness(dir, {
    BOTLING_AGENT: "claude", BOTLING_HARMLESS: "1", BOTLING_QUIT_TIDY_MS: "0", CODEX_HOME: home(),
    ...(process.env.BOTLING_MODEL ? { BOTLING_MODEL: process.env.BOTLING_MODEL } : {}),
  });
  harnesses.push(c);
  return { c, dir };
}

describe.skipIf(!live)("real codex app-server", () => {
  it("a Codex head answers a short message through app-server, as a coordinator", async () => {
    const { c, dir } = core(["codex"]);
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "Reply with the single word: hello. Do not use any tools or workers." });
    const finished = await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === turnId), { timeout: 180_000, what: "codex to finish" });
    console.log("codex:", JSON.stringify(finished.event));
    expect(finished.event).toMatchObject({ status: "done" });
    expect((finished.event as { text: string }).text.toLowerCase()).toContain("hello");
    const reply = (await c.chat()).messages.findLast((m: any) => m.role === "bot");
    expect(reply.engine).toBe("codex");
    // The bot's session is a Codex thread, kept as 1.x keeps it.
    const files = readdirSync(join(dir, "codex-threads"));
    expect(files.some((file) => /^[0-9a-f-]{36}$/.test(file))).toBe(true);
    expect(files.some((file) => file.endsWith(".managed"))).toBe(true);
  }, 200_000);

  it("two real heads: Claude reads a message to both first, Codex gets it with Claude's reply", async () => {
    const { c } = core(["claude", "codex"]);
    await c.call({ type: "chat.send", botId: MAIN, text: "Say hi in at most five words. Do not use any tools or workers." });
    const done = await until(async () => {
      const finished = c.of("turn.finished").map((e) => e.event as { messageId: string; status: string; text: string });
      return finished.length >= 2 ? finished : null;
    }, { timeout: 240_000, what: "both heads to finish" });
    const chat = await c.chat();
    const claude = chat.messages.find((m: any) => m.role === "bot" && m.engine === "claude");
    const codex = chat.messages.find((m: any) => m.role === "bot" && m.engine === "codex");
    console.log("finished:", JSON.stringify(done), "\nclaude:", claude?.text, "\ncodex:", codex?.text ?? "(said <no-reply/>)");
    expect(claude?.state).toBe("done");
    expect(c.stderr).toContain("Claude reads it first; Codex waits for what it takes on");
    expect(c.stderr).toContain("Codex gets the message with what the other head said");
    expect(done.every((event) => event.status === "done")).toBe(true);
  }, 300_000);
});
