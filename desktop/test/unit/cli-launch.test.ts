import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ClaudeHead, type HeadExit } from "../../src/core/agent/head";
import { CodexHead, CodexThreads } from "../../src/core/agent/codex";
import { fakeCli, fakeCodex, tempDir, until } from "../helpers";

const heads: (ClaudeHead | CodexHead)[] = [];
afterEach(async () => { for (const head of heads.splice(0)) { await head.terminate(100); await head.exited; } });

function guiHome() {
  const home = tempDir("gui-cli home ");
  const env = {
    HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    CODEX_HOME: join(home, "existing-codex"), CLAUDE_CONFIG_DIR: join(home, "existing-claude"),
    CLAUDECODE: "nested", ELECTRON_RUN_AS_NODE: "1",
  };
  for (const folder of [env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) {
    mkdirSync(folder); writeFileSync(join(folder, "keep.txt"), "existing config, untouched");
  }
  // Codex's npm entry point needs /usr/bin/env node, too. Finder supplies neither bin directory.
  mkdirSync(join(home, ".nix-profile/bin"), { recursive: true });
  symlinkSync(process.execPath, join(home, ".nix-profile/bin/node"));
  return { home, env };
}

function install(home: string, command: "claude" | "codex") {
  const file = join(home, command === "claude" ? ".local/bin/claude" : ".npm-global/bin/codex");
  mkdirSync(dirname(file), { recursive: true });
  const fixture = command === "claude" ? fakeCli : fakeCodex;
  writeFileSync(file, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(home, `${command}-launch.json`))}, JSON.stringify({ home: process.env.HOME, codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR, nested: process.env.CLAUDECODE, electron: process.env.ELECTRON_RUN_AS_NODE }));\nawait import(${JSON.stringify(pathToFileURL(fixture).href)});\n`);
  chmodSync(file, 0o755);
}

describe.skipIf(process.platform === "win32")("CLI launch from Finder's minimal PATH", () => {
  for (const engine of ["claude", "codex"] as const) {
    it(`starts the ${engine} head from its user install and completes a protocol turn`, async () => {
      const { home, env } = guiHome();
      install(home, engine);
      const items: any[] = [];
      let exit: HeadExit | undefined;
      const common = { command: engine, cwd: home, env, sessionId: "gui-session", resume: false };
      const handlers = { onItem: (item: any) => items.push(item), onExit: (value: HeadExit) => { exit = value; } };
      const head = engine === "claude"
        ? new ClaudeHead({ ...common, allowedTools: [], harmless: true }, handlers)
        : new CodexHead({ ...common, threads: new CodexThreads(join(home, "threads")), instructions: "", workerInstructions: null }, handlers);
      heads.push(head);
      head.start();
      head.send("hello", "gui-message");
      await until(() => exit || items.find(item => item.kind === "result"), { timeout: 3000 });
      expect(exit?.stderr ?? "").toBe("");
      expect(items).toContainEqual(expect.objectContaining({ kind: "result", ok: true }));
      expect(JSON.parse(readFileSync(join(home, `${engine}-launch.json`), "utf8"))).toEqual({ home, codex: env.CODEX_HOME, claude: env.CLAUDE_CONFIG_DIR });
      for (const folder of [env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) expect(readFileSync(join(folder, "keep.txt"), "utf8")).toBe("existing config, untouched");
    });
  }
});
