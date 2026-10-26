// 1.x's "always allow" rules (Bot.swift ~1727-1748) answer a permission request in 2.x too:
// the matcher itself, then a rule written by 1.x in bot.json letting one command through.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { alwaysAllows, isPermissionRule, ruleMatches } from "../../src/core/permission-rules";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

const folder = "/Users/me/garden";
const bash = (command: string) => ({ tool: "Bash", input: { command } });
const file = (tool: string, file_path: string) => ({ tool, input: { file_path } });

describe("permission rules", () => {
  it("tells rules from tool names", () => {
    expect(isPermissionRule("Bash(npm test)")).toBe(true);
    expect(isPermissionRule("WebFetch")).toBe(false);
  });

  it("bare names: the tool itself, or a whole MCP server", () => {
    expect(ruleMatches("WebFetch", { tool: "WebFetch", input: {} }, folder)).toBe(true);
    expect(ruleMatches("WebFetch", { tool: "WebSearch", input: {} }, folder)).toBe(false);
    expect(ruleMatches("mcp__github", { tool: "mcp__github__get_issue", input: {} }, folder)).toBe(true);
    expect(ruleMatches("mcp__github__*", { tool: "mcp__github__get_issue", input: {} }, folder)).toBe(true);
    expect(ruleMatches("mcp__github", { tool: "mcp__githubx__get_issue", input: {} }, folder)).toBe(false);
  });

  it("Bash: the exact command; prefix and wildcard rules never cover a chained one", () => {
    expect(ruleMatches("Bash(npm test)", bash("npm test"), folder)).toBe(true);
    expect(ruleMatches("Bash(npm test)", bash("  npm test \n"), folder)).toBe(true);
    expect(ruleMatches("Bash(npm test)", bash("npm test -- --watch"), folder)).toBe(false);
    expect(ruleMatches("Bash(npm run:*)", bash("npm run build"), folder)).toBe(true);
    expect(ruleMatches("Bash(npm run:*)", bash("npm run"), folder)).toBe(true);
    expect(ruleMatches("Bash(npm run:*)", bash("npm runaway"), folder)).toBe(false);
    expect(ruleMatches("Bash(npm run:*)", bash("npm run build && rm -rf /"), folder)).toBe(false);
    expect(ruleMatches("Bash(npm run:*)", bash("npm run x; curl evil"), folder)).toBe(false);
    expect(ruleMatches("Bash(npm run:*)", bash("npm run $(whoami)"), folder)).toBe(false);
    expect(ruleMatches("Bash(npm run:*)", bash("npm run x > /etc/passwd"), folder)).toBe(false);
    expect(ruleMatches("Bash(git * main)", bash("git push origin main"), folder)).toBe(true);
    expect(ruleMatches("Bash(git * main)", bash("git push origin dev"), folder)).toBe(false);
    expect(ruleMatches("Bash(npm test)", { tool: "Bash", input: {} }, folder)).toBe(false);
    expect(ruleMatches("Bash(npm test)", file("Edit", "/x"), folder)).toBe(false);
  });

  it("files: Edit rules cover every file-writing tool, by absolute, home, folder and relative patterns", () => {
    expect(ruleMatches("Edit(//Users/me/garden/notes.md)", file("Write", "/Users/me/garden/notes.md"), folder)).toBe(true);
    expect(ruleMatches("Edit(//Users/me/garden/notes.md)", file("MultiEdit", "/Users/me/garden/notes.md"), folder)).toBe(true);
    expect(ruleMatches("Edit(//Users/me/garden/notes.md)", file("Edit", "/Users/me/garden/other.md"), folder)).toBe(false);
    expect(ruleMatches("Edit(//Users/me/garden/notes.md)", file("Read", "/Users/me/garden/notes.md"), folder)).toBe(false);
    expect(ruleMatches("Edit(/src/**)", file("Edit", "/Users/me/garden/src/a/b.ts"), folder)).toBe(true);
    expect(ruleMatches("Edit(/src/**)", file("Edit", "/Users/me/other/src/a.ts"), folder)).toBe(false);
    expect(ruleMatches("Edit(src/*.ts)", file("Edit", "/Users/me/garden/src/a.ts"), folder)).toBe(true);
    expect(ruleMatches("Edit(src/*.ts)", file("Edit", "/Users/me/garden/src/deep/a.ts"), folder)).toBe(false);
    expect(ruleMatches("Edit(*.md)", file("Edit", "/Users/me/garden/docs/x.md"), folder)).toBe(true);
    expect(ruleMatches("Edit(docs)", file("Edit", "/Users/me/garden/docs/x.md"), folder)).toBe(true);
    expect(ruleMatches("Edit(/src/**)", file("Edit", "/Users/me/garden/src/../../escape.ts"), folder)).toBe(false);
    expect(ruleMatches("Edit(~/notes/**)", file("Edit", join(homedir(), "notes/today.md")), folder)).toBe(true);
    expect(ruleMatches("Read(/src/**)", { tool: "Grep", input: { path: "/Users/me/garden/src" } }, folder)).toBe(true);
    expect(ruleMatches("Edit(/src/**)", file("Edit", "src/a.ts"), folder)).toBe(false);
  });

  it("WebFetch: the host, or its subdomains", () => {
    const fetch = (url: string) => ({ tool: "WebFetch", input: { url } });
    expect(ruleMatches("WebFetch(domain:example.com)", fetch("https://example.com/a"), folder)).toBe(true);
    expect(ruleMatches("WebFetch(domain:example.com)", fetch("https://evil-example.com/a"), folder)).toBe(false);
    expect(ruleMatches("WebFetch(domain:example.com)", fetch("https://api.example.com/a"), folder)).toBe(false);
    expect(ruleMatches("WebFetch(domain:*.example.com)", fetch("https://api.example.com/a"), folder)).toBe(true);
    expect(ruleMatches("WebFetch(domain:*.example.com)", fetch("https://badexample.com/a"), folder)).toBe(false);
    expect(ruleMatches("WebFetch(domain:example.com)", fetch("not a url"), folder)).toBe(false);
  });

  it("an unknown rule never matches; any entry of a list may", () => {
    expect(ruleMatches("Skill(review)", { tool: "Skill", input: { skill: "review" } }, folder)).toBe(false);
    expect(alwaysAllows(["WebSearch", "Bash(ls)"], bash("ls"), folder)).toBe(true);
    expect(alwaysAllows([], bash("ls"), folder)).toBe(false);
  });
});

const harnesses: CoreHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});

describe("a 1.x rule in bot.json", () => {
  it("lets that command through without a card; another command still asks", async () => {
    const dir = tempDir("rules");
    mkdirSync(join(dir, "main"), { recursive: true });
    writeFileSync(join(dir, "main", "bot.json"), JSON.stringify({ unread: 0, alwaysAllowed: ["Bash(echo hi)"] }));
    const c = new CoreHarness(dir);
    harnesses.push(c);
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "/tool echo hi" });
    const finished = await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === turnId));
    expect((finished.event as { text: string }).text).toMatch(/Allowed: ran echo hi/);
    expect(c.of("message.added").some((e) => (e.event as { message: { approval?: unknown } }).message.approval)).toBe(false);
    await c.call({ type: "chat.send", botId: MAIN, text: "/tool echo bye" });
    await until(() => c.of("message.added").map((e) => (e.event as { message: any }).message).find((m) => m.approval), { what: "an approval" });
  });
});
