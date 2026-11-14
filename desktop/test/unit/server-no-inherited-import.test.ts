// M1 demo bug 4: botlingd started by the Botling 3 window (and `botlingd start`) imported 1.x data because it inherited
// BOTLING_IMPORT_FROM / BOTLING_1X_DIR (a shell or app that ran 2.x carries them). Importing 1.x/2.x data is M6's
// explicit step: neither path acts on them now.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { botlingdLaunchEnv, serverPaths } from "../../src/main-v3/server-client";
import { dropInheritedImport } from "../../src/server/inherited-env";
import { botlingdEnv, botlingdScript, testRoot } from "../botlingd-harness";

const root = testRoot("no-import");
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A folder that looks like a 1.x data folder to the 2.x importer (core/store/importer.ts `looksLike1x`). */
function old1x(): string {
  const dir = join(root, "old-1x");
  mkdirSync(join(dir, "main"), { recursive: true });
  writeFileSync(join(dir, "projects.json"), "[]");
  writeFileSync(join(dir, "main", "chat.json"), JSON.stringify([{ role: "user", text: "from 1.x", time: new Date(0).toISOString() }]));
  return dir;
}

describe("the import variables", () => {
  it("the window starts botlingd without them, keeping everything else", () => {
    const paths = serverPaths({ BOTLING_APP_DATA_DIR: "/tmp/app" });
    const env = botlingdLaunchEnv({ PATH: "/bin", BOTLING_IMPORT_FROM: "/old", BOTLING_1X_DIR: "/old", BOTLING_APP_DATA_DIR: "/tmp/app", BOTLING_AGENT: "fake" }, paths);
    expect(env).toEqual({ PATH: "/bin", BOTLING_APP_DATA_DIR: "/tmp/app", BOTLING_AGENT: "fake", ELECTRON_RUN_AS_NODE: "1", BOTLING_DATA_DIR: paths.serverDir, BOTLING_PLUGIN_HOST: "node" });
  });

  it("botlingd takes them out of its own environment and says which", () => {
    const env: Record<string, string | undefined> = { PATH: "/bin", BOTLING_IMPORT_FROM: "/old", BOTLING_1X_DIR: "" };
    expect(dropInheritedImport(env)).toEqual(["BOTLING_IMPORT_FROM"]);
    expect(env).toEqual({ PATH: "/bin" });
    expect(dropInheritedImport(env)).toEqual([]);
  });

  const electron = createRequire(import.meta.url)("electron") as unknown as string;
  it.each([
    { name: "node", bin: process.execPath, env: {} as Record<string, string> },
    { name: "electron (as the window starts it)", bin: electron, env: { ELECTRON_RUN_AS_NODE: "1" } as Record<string, string> },
  ])("botlingd start under $name with them inherited imports nothing", { timeout: 60_000 }, async ({ name, bin, env }) => {
    const source = old1x();
    const dataDir = join(root, `data-${name.split(" ")[0]}`);
    const child = spawn(bin, ["--no-warnings", botlingdScript, "start"], {
      env: { ...botlingdEnv(dataDir, { BOTLING_IMPORT_FROM: source, BOTLING_1X_DIR: source, BOTLING_SERVER_BACKUP_CHECK_MS: "0" }), ...env }, stdio: "pipe",
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`botlingd did not get ready: ${stderr}`)), 45_000);
        createInterface({ input: child.stdout }).on("line", (line) => { if (line.startsWith("ready ")) { clearTimeout(timer); resolve(); } });
        child.once("close", (code) => { clearTimeout(timer); reject(new Error(`botlingd exited ${code}: ${stderr}`)); });
      });
      // The core's import runs as it starts (core/server.ts `importOnce`), before botlingd says ready.
      const log = existsSync(join(dataDir, "botlingd.log")) ? readFileSync(join(dataDir, "botlingd.log"), "utf8") : "";
      expect(log).not.toMatch(/import(ed)? .*from|nothing to import/);
      expect(log).not.toContain(source);
      expect(stderr).toContain("ignoring BOTLING_IMPORT_FROM and BOTLING_1X_DIR from the environment");
    } finally {
      child.kill("SIGTERM");
      await closed;
    }
  });
});
