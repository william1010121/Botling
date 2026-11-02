// The Catch-up summary model is an engine and a model: how it is saved (an older Codex-only value stays Codex),
// which summarizer an engine gets, and the Claude one against a fake `claude` binary.
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AGY_SUMMARY_UNAVAILABLE, claudeSummarizer, claudeSummaryArguments, engineSummarizer, catchUpSettings, parseClaudeResult, SETTING, SummaryFailure, type Summarizer } from "../src/catchup";
import { legacySettings } from "../src/migrate";

const dir = mkdtempSync(join(tmpdir(), "botling-fake-claude-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const BULLETS = { bullets: ["Built it. [[source:AAA]]"] };

/** A `claude` stand-in: FAKE_CLAUDE_SUMMARY picks what it prints; it records its arguments, stdin and folder. */
function fakeClaude() {
  const script = join(dir, "claude.mjs");
  writeFileSync(script, `import { writeFileSync, readFileSync, readdirSync } from "node:fs";
const mode = process.env.FAKE_CLAUDE_SUMMARY ?? "ok";
const stdin = readFileSync(0, "utf8");
writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args: process.argv.slice(2), stdin, cwd: process.cwd(), files: readdirSync(process.cwd()) }));
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "crash") process.exit(3);
else if (mode === "garbage") console.log("not json at all");
else if (mode === "error") console.log(JSON.stringify({ type: "result", is_error: true, result: "Not logged in" }));
else if (mode === "empty") console.log(JSON.stringify({ type: "result", is_error: false, structured_output: { bullets: [] } }));
else if (mode === "text") console.log(JSON.stringify({ type: "result", is_error: false, result: "\`\`\`json\\n" + JSON.stringify(${JSON.stringify(BULLETS)}) + "\\n\`\`\`" }));
else console.log(JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(${JSON.stringify(BULLETS)}), structured_output: ${JSON.stringify(BULLETS)} }));
`);
  chmodSync(script, 0o755);
  return script;
}
const run = (mode: string, timeout = 5000) => {
  const log = join(dir, `log-${mode}-${Math.random().toString(36).slice(2)}.json`);
  const summarize = claudeSummarizer({ file: process.execPath, prefixArgs: [fakeClaude()], env: { ELECTRON_RUN_AS_NODE: "1", FAKE_CLAUDE_SUMMARY: mode, FAKE_CLAUDE_LOG: log } }, timeout);
  return { summarize, log };
};

/** The plugin's settings as `api.settings.get` reads them (unset: undefined, as before its defaults apply). */
const from = (values: Record<string, unknown>) => (key: string) => values[key];

describe("the saved summary model", () => {
  it("nothing saved is Codex's default; an older Codex id stays Codex", () => {
    expect(catchUpSettings(from({}))).toMatchObject({ engine: "codex", model: "gpt-6-luna" });
    expect(catchUpSettings(from(legacySettings({ catchUpModelChoice: "gpt-5-old" })))).toMatchObject({ engine: "codex", model: "gpt-5-old" });
    expect(catchUpSettings(from({ [SETTING.engine]: "claude", [SETTING.model]: "  " }))).toMatchObject({ engine: "codex", model: "gpt-6-luna" });
  });

  it("engine and model come from the settings; 1.x's keys are taken over once", () => {
    expect(catchUpSettings(from({ [SETTING.engine]: "claude", [SETTING.model]: "sonnet" }))).toMatchObject({ engine: "claude", model: "sonnet" });
    expect(legacySettings({ catchUpModelChoice: "sonnet", catchUpModelEngine: "claude" })).toEqual({ [SETTING.model]: "sonnet", [SETTING.engine]: "claude" });
    expect(legacySettings({ catchUpModelChoice: "gpt-6-sol" })).toEqual({ [SETTING.model]: "gpt-6-sol", [SETTING.engine]: "codex" });
    expect(legacySettings({})).toEqual({});
  });
});

describe("the summarizer follows the engine", () => {
  const stub = (name: string): Summarizer => async (_p, model, _l, engine) => [`${name}:${model}:${engine}`];
  it("Claude to Claude's, Codex (and no engine) to Codex's, Antigravity is refused", async () => {
    const summarize = engineSummarizer({ claude: stub("claude"), codex: stub("codex") });
    expect(await summarize("p", "sonnet", "en", "claude")).toEqual(["claude:sonnet:claude"]);
    expect(await summarize("p", "gpt-6-luna", "en", "codex")).toEqual(["codex:gpt-6-luna:codex"]);
    expect(await summarize("p", "gpt-6-luna", "en")).toEqual(["codex:gpt-6-luna:codex"]);
    await expect(summarize("p", "x", "en", "agy")).rejects.toThrow(AGY_SUMMARY_UNAVAILABLE);
    await expect(engineSummarizer({ codex: stub("codex") })("p", "sonnet", "en", "claude")).rejects.toBeInstanceOf(SummaryFailure);
  });
});

describe("the Claude summarizer", () => {
  it("returns the bullets, with no tools, in a fresh temp folder that is removed after", async () => {
    const { summarize, log } = run("ok");
    expect(await summarize("the messages", "sonnet", "en", "claude")).toEqual(BULLETS.bullets);
    const call = JSON.parse(readFileSync(log, "utf8"));
    expect(call.args).toEqual(claudeSummaryArguments("sonnet", "en"));
    expect(call.args).toEqual(expect.arrayContaining(["-p", "--output-format", "json", "--model", "sonnet", "--strict-mcp-config", "--no-session-persistence"]));
    expect(call.args[call.args.indexOf("--tools") + 1]).toBe("");
    expect(call.stdin).toMatch(/^Summarize these messages\. Do not use any tools\.\nthe messages$/);
    expect(call.cwd).toContain("botling-catchup-");
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("botling-catchup-") && call.cwd.endsWith(name))).toEqual([]);
  });

  it("reads bullets from fenced result text too", async () => {
    expect(await run("text").summarize("m", "haiku", "en", "claude")).toEqual(BULLETS.bullets);
  });

  it("a timeout, a crash, a claude-side error and bad output each fail with the right words", async () => {
    await expect(run("hang", 300).summarize("m", "haiku", "en", "claude")).rejects.toThrow(/timed out after 0 s|timed out/);
    await expect(run("crash").summarize("m", "haiku", "en", "claude")).rejects.toThrow("The model call failed; check your Claude login and model access.");
    await expect(run("error").summarize("m", "haiku", "en", "claude")).rejects.toThrow("The model did not return a summary.");
    await expect(run("garbage").summarize("m", "haiku", "en", "claude")).rejects.toThrow("The model did not return a summary.");
    await expect(run("empty").summarize("m", "haiku", "en", "claude")).rejects.toThrow("The model did not return a summary.");
  });

  it("a missing claude says so", async () => {
    await expect(claudeSummarizer({ file: join(dir, "nope-claude") }, 2000)("m", "haiku", "en", "claude")).rejects.toThrow(/Claude was not found|check your Claude login/);
  });

  it("parses structured output, the result text, and rejects errors", () => {
    expect(parseClaudeResult(JSON.stringify({ structured_output: BULLETS }))).toEqual(BULLETS.bullets);
    expect(() => parseClaudeResult(JSON.stringify({ is_error: true, structured_output: BULLETS }))).toThrow();
  });
});
