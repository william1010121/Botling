// The app tools each coordinator gets, pinned byte for byte (provider-layer plan, step 1). The goldens in
// test/fixtures/app-tools/ are what the three engines were given before the tools came from one registry: Claude's
// in-process MCP server, the agy bridge (its constant and what a bridge with workers lists), and Codex's dynamic tools.
// Codex's are fixed when a coordinator thread starts: any change to them changes MANAGED_TOOL_SIGNATURE and restarts
// every Codex coordinator thread, so the signature's hash is pinned too. Change a golden only on purpose.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CLAUDE_APP_TOOLS } from "../../src/core/agent/claude-workers";
import { AGY_WORKER_TOOLS, AgyMcpBridge } from "../../src/core/agent/agy-mcp";
import { MANAGED_TOOLS, MANAGED_TOOL_SIGNATURE } from "../../src/core/agent/codex";

const golden = (name: string) => readFileSync(join(__dirname, "../fixtures/app-tools", `${name}.json`), "utf8");
const pretty = (value: unknown) => JSON.stringify(value, null, 1) + "\n";
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe("app tools, byte for byte", () => {
  it("Claude's MCP tools", () => {
    expect(pretty(CLAUDE_APP_TOOLS)).toBe(golden("claude"));
  });
  it("agy's worker tools, and what a bridge with workers lists (handoff to agy only)", () => {
    expect(pretty(AGY_WORKER_TOOLS)).toBe(golden("agy"));
    const cwd = mkdtempSync(join(tmpdir(), "botling-app-tools-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, "private-profile"));
    const bridge = new AgyMcpBridge(cwd, join(cwd, "private-profile"), async () => ({}));
    expect(pretty(bridge.tools)).toBe(golden("agy-bridge"));
  });
  it("Codex's dynamic tools, and their signature (a change restarts every Codex coordinator thread)", () => {
    expect(pretty(MANAGED_TOOLS)).toBe(golden("codex"));
    expect(MANAGED_TOOL_SIGNATURE).toBe(JSON.stringify(JSON.parse(golden("codex"))));
    expect(createHash("sha256").update(MANAGED_TOOL_SIGNATURE).digest("hex")).toBe("ec5c76def245474b0e6a8a950189ca6043676599e0d1a2fdbb7546d9e0790b16");
  });
});
