// Browser site tools (<data>/browser-tools/) are made and kept by Maintainer alone, so every bot reuses them: a bot
// asks with <plugin>, the bots' Claude heads and workers are refused writes there, and Maintainer is told to build a
// visual tool against the page's saved HTML and to finish with a screenshot.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeHead, SITE_TOOLS_GUARD_HOOK, type HeadConfig } from "../../src/core/agent/head";
import { SITE_TOOLS_DENIED, siteToolsFolder, siteToolsGuardDecision } from "../../src/core/site-tools-guard";
import { botPrompts } from "../../src/core/prompts";
import { SITE_TOOLS_RULE } from "../../src/core/prompts";
import { maintainerVisualToolRules } from "../../src/core/maintainer-text";
import { SITE_TOOLS_GUIDE_TEXT } from "../../src/main/site-tools-guide";
import { claudeHarness } from "../claude-workers-fake";

const FOLDER = "/data/browser-tools";
const hook = (tool_name: string, tool_input: Record<string, unknown>) => ({ hook_event_name: "PreToolUse", tool_name, tool_input });
const denied = (decision: Record<string, unknown>) => (decision as any).hookSpecificOutput?.permissionDecision === "deny";

describe("the site tools guard", () => {
  it.each([
    ["Write", { file_path: `${FOLDER}/hn-export/script.js`, content: "x" }],
    ["Edit", { file_path: `${FOLDER}/hn-export/tool.json`, old_string: "a", new_string: "b" }],
    ["MultiEdit", { file_path: `${FOLDER}/../browser-tools/x/script.js` }],
    ["Bash", { command: `cat > ${FOLDER}/x/script.js <<'E'\nE` }],
    ["Bash", { command: `mkdir -p ${FOLDER}/x && echo hi > ${FOLDER}/x/tool.json` }],
    ["Bash", { command: `cp /tmp/script.js ${FOLDER}/x/` }],
    ["Bash", { command: `rm -rf ${FOLDER}/x` }],
  ])("denies %s %j", (tool, input) => {
    const decision = siteToolsGuardDecision(hook(tool, input), { folder: FOLDER, cwd: "/p" });
    expect(denied(decision)).toBe(true);
    expect((decision as any).hookSpecificOutput.permissionDecisionReason).toBe(SITE_TOOLS_DENIED);
  });

  it.each([
    ["Read", { file_path: `${FOLDER}/README.md` }],
    ["Write", { file_path: "/p/src/a.ts", content: "x" }],
    ["Write", { file_path: "/data/browser-tools-state.json", content: "x" }],
    ["Bash", { command: `ls ${FOLDER} && cat ${FOLDER}/README.md` }],
    ["Bash", { command: "echo x > /tmp/a" }],
  ])("allows %s %j", (tool, input) => {
    expect(siteToolsGuardDecision(hook(tool, input), { folder: FOLDER, cwd: "/p" })).toEqual({});
  });

  it.each([
    ["Write", { file_path: "/Users/u/Library/Application Support/Botling 2/browser-tools/gemini-export/script.js", content: "x" }],
    ["Bash", { command: "cat > \"/Users/u/Library/Application Support/Botling 2/browser-tools/gemini-export/script.js\" <<'EOF'\nx\nEOF" }],
    ["Bash", { command: "cd \"/Users/u/Library/Application Support/Botling 2/browser-tools\" && cat > gemini-wide/tool.json <<EOF\n{}\nEOF" }],
  ])("denies %s into a folder whose path has spaces %j", (tool, input) => {
    expect(denied(siteToolsGuardDecision(hook(tool, input), { folder: "/Users/u/Library/Application Support/Botling 2/browser-tools", cwd: "/p" }))).toBe(true);
  });

  it("guards the app's site tools folder, not one inside the core's data folder", () => {
    // The core runs with BOTLING_DATA_DIR=<app data>/core; the app keeps the site tools in <app data>/browser-tools.
    expect(siteToolsFolder("/A/Botling 2/core", "/A/Botling 2")).toBe("/A/Botling 2/browser-tools");
    expect(siteToolsFolder("/d", null)).toBe("/d/browser-tools");
  });

  it("the denial tells the session to ask Maintainer", () => {
    expect(SITE_TOOLS_DENIED).toContain("Maintainer");
    expect(SITE_TOOLS_DENIED).toContain("<plugin>");
  });
});

describe("a Claude head with the site tools guard", () => {
  function transport(config: Partial<HeadConfig>) {
    const writes: any[] = [];
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin.on("data", (chunk) => { for (const line of String(chunk).split("\n").filter(Boolean)) writes.push(JSON.parse(line)); });
    const head = new ClaudeHead({ command: "claude", cwd: mkdtempSync(join(tmpdir(), "botling-site-guard-")), sessionId: "s", resume: false, allowedTools: [], ...config }, { onItem() {}, onExit() {} },
      { platform: "test", verified: true, spawn: () => ({ pid: 1, child, terminate: async () => ({ killed: [], forced: false }) }) } as any);
    head.start();
    const ask = async (id: string, tool_name: string, tool_input: Record<string, unknown>) => {
      child.stdout.write(JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "hook_callback", callback_id: SITE_TOOLS_GUARD_HOOK, input: hook(tool_name, tool_input) } }) + "\n");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return writes.find((w) => w.response?.request_id === id).response.response;
    };
    return { head, writes, ask };
  }

  it("registers the hook before any input, only when given a folder and not for a harmless head", () => {
    const t = transport({ siteToolsGuard: { folder: FOLDER } });
    expect(t.writes[0].request).toMatchObject({ subtype: "initialize",
      hooks: { PreToolUse: expect.arrayContaining([{ matcher: "^(Edit|Write|MultiEdit|NotebookEdit|Bash)$", hookCallbackIds: [SITE_TOOLS_GUARD_HOOK] }]) } });
    expect(JSON.stringify(transport({ tools: ["Read"] }).writes)).not.toContain(SITE_TOOLS_GUARD_HOOK);
    expect(JSON.stringify(transport({ siteToolsGuard: { folder: FOLDER }, harmless: true }).writes)).not.toContain(SITE_TOOLS_GUARD_HOOK);
  });

  it("denies a write into the folder and lets a read through", async () => {
    const t = transport({ siteToolsGuard: { folder: FOLDER } });
    expect(denied(await t.ask("h1", "Write", { file_path: `${FOLDER}/x/script.js`, content: "x" }))).toBe(true);
    expect(await t.ask("h2", "Read", { file_path: `${FOLDER}/README.md` })).toEqual({});
  });

  it("a bot's Claude workers carry the bot's guard", async () => {
    const h = claudeHarness(undefined, { siteToolsFolder: () => FOLDER });
    await h.workers.tool("app_handoff", { instructions: "Make a site tool" });
    expect(h.heads[0]!.config).toMatchObject({ siteToolsGuard: { folder: FOLDER } });
    await h.workers.close();
  });
});

describe("who is told what", () => {
  it("every bot hears that site tools are Maintainer's and to ask with <plugin>", () => {
    expect(SITE_TOOLS_RULE).toContain("Maintainer");
    expect(SITE_TOOLS_RULE).toContain("<plugin>");
    const profile = { id: "b", name: "B", role: "manager" as const, folder: "/p", memoryPath: ".bot/memory.md", job: null, instructions: null };
    // Antigravity heads are told no Maintainer tags (the app refuses them there).
    for (const engine of ["claude", "codex"] as const) expect(botPrompts({ profile, engine, heads: null, language: "en" } as any).system).toContain(SITE_TOOLS_RULE);
  });

  it("Maintainer builds a visual tool against the saved HTML and ends with a screenshot", () => {
    const rules = maintainerVisualToolRules(FOLDER);
    expect(rules).toContain(FOLDER);
    expect(rules).toMatch(/save the target page's HTML/i);
    expect(rules).toMatch(/screenshot/i);
    expect(rules).toMatch(/never report a visual tool done without/i);
  });

  it("the folder's README says Maintainer makes the tools, and how", () => {
    expect(SITE_TOOLS_GUIDE_TEXT).toContain("made and kept by Maintainer");
    expect(SITE_TOOLS_GUIDE_TEXT).toMatch(/screenshot/i);
  });
});
