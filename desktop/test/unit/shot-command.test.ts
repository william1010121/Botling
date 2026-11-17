// BOTLING_SHOT_COMMAND is the path of one script (core/shot-command.ts), so `$BOTLING_SHOT_COMMAND <folder> --out <dir>`
// works in zsh as well as bash: zsh does not split a variable and treats the quotes inside it as plain characters.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SHOT_WRAPPER, UNQUOTED_SAFE, installShotWrapper, shellQuote, shotCommand, shotWrapperDirs, shotWrapperScript,
} from "../../src/core/shot-command";
import { setPackagedSelfCommands } from "../../src/main-v3/main";
import { tempDir } from "../helpers";

const shellPath = (name: string) => ["/bin/", "/usr/bin/"].map((dir) => dir + name).find((file) => existsSync(file)) ?? null;
const shells = ["sh", "bash", "zsh"].map((name) => [name, shellPath(name)] as const);

/** A stand-in for the Botling binary at a path with a space and a quote: prints whether ELECTRON_RUN_AS_NODE reached it, then each argument on a line. */
function fakeBinary(root: string): string {
  const folder = join(root, "Application Support", "Bot'ling 3.app", "Contents", "MacOS");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "Botling 3");
  writeFileSync(file, `#!/bin/sh\nprintf 'run-as-node=%s\\n' "\${ELECTRON_RUN_AS_NODE-unset}"\nfor a in "$@"; do printf 'arg=%s\\n' "$a"; done\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("the wrapper script", () => {
  it("quotes every word for sh and ends with the flag and the caller's arguments", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    const text = shotWrapperScript(["/Applications/Botling 3.app/Contents/MacOS/Botling 3", "/dev/it's app"]);
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).toContain(`exec env -u ELECTRON_RUN_AS_NODE '/Applications/Botling 3.app/Contents/MacOS/Botling 3' '/dev/it'\\''s app' --component-shot "$@"\n`);
  });

  it("is placed only where its path is one word in every shell: Application Support is passed over", () => {
    expect(UNQUOTED_SAFE.test("/Users/me/.botling/bin/botling-component-shot")).toBe(true);
    for (const bad of ["/Users/me/Library/Application Support/Botling/bin/x", "/tmp/it's/x", "/tmp/$HOME/x", "/tmp/a*/x", "/tmp/~/x", "relative/x", "/tmp/a;b/x"]) expect(UNQUOTED_SAFE.test(bad)).toBe(false);
    const dirs = shotWrapperDirs({ dataDir: "/Users/me/Library/Application Support/Botling 3", home: "/Users/me", tmp: "/var/folders/ab/T", uid: 501 });
    expect(dirs).toEqual(["/Users/me/.botling/bin", "/var/folders/ab/T/botling-bin-501"]);
    expect(shotWrapperDirs({ dataDir: "/data/botling", home: "/Users/me" })).toEqual(["/data/botling/bin", "/Users/me/.botling/bin"]);
    expect(shotWrapperDirs({ dataDir: "/a b", home: "/h h" })).toEqual([]);
  });
});

describe("installing it", () => {
  it("writes an executable script, leaves an identical one alone and replaces a stale or non-executable one", () => {
    const dir = join(tempDir("shot-wrapper"), "bin");
    const file = installShotWrapper(["/x/botling"], [dir]);
    expect(file).toBe(join(dir, SHOT_WRAPPER));
    expect(statSync(file!).mode & 0o777).toBe(0o755);
    const before = statSync(file!).ino;
    expect(installShotWrapper(["/x/botling"], [dir])).toBe(file);
    expect(statSync(file!).ino).toBe(before);

    writeFileSync(file!, "stale\n");
    chmodSync(file!, 0o644);
    expect(installShotWrapper(["/x/botling"], [dir])).toBe(file);
    expect(readFileSync(file!, "utf8")).toBe(shotWrapperScript(["/x/botling"]));
    expect(statSync(file!).mode & 0o111).not.toBe(0);
    expect(readdirSync(dir)).toEqual([SHOT_WRAPPER]); // no staging file left behind
  });

  it("writes over a link in its place, not through it, and passes over a folder others may write to", () => {
    const root = tempDir("shot-wrapper-safety");
    const victim = join(root, "victim.txt");
    writeFileSync(victim, "keep me");
    const dir = join(root, "bin");
    mkdirSync(dir);
    symlinkSync(victim, join(dir, SHOT_WRAPPER));
    expect(installShotWrapper(["/x/botling"], [dir])).toBe(join(dir, SHOT_WRAPPER));
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(readFileSync(join(dir, SHOT_WRAPPER), "utf8")).toBe(shotWrapperScript(["/x/botling"]));

    const open = join(root, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    const good = join(root, "good");
    expect(installShotWrapper(["/x/botling"], [open, good])).toBe(join(good, SHOT_WRAPPER));
    expect(existsSync(join(open, SHOT_WRAPPER))).toBe(false);
  });

  it("falls back to the long command only when no place takes it", () => {
    const blocker = join(tempDir("shot-wrapper-none"), "file");
    writeFileSync(blocker, "x");
    expect(installShotWrapper(["/x/botling"], [join(blocker, "bin")])).toBeNull();
    expect(shotCommand(["/x/my botling"], [join(blocker, "bin")])).toBe("env -u ELECTRON_RUN_AS_NODE '/x/my botling' --component-shot");
    expect(shotCommand(["/x/botling"], [join(tempDir("shot-wrapper-ok"), "bin")])).toMatch(new RegExp(`/bin/${SHOT_WRAPPER}$`));
  });
});

describe("what a bot's shell makes of it", () => {
  const root = tempDir("shot-wrapper-run");
  const binary = fakeBinary(root);
  const command = shotCommand([binary], shotWrapperDirs({ dataDir: join(root, "Application Support"), home: join(root, "home") }));
  const folder = "my card's folder (v2)";
  const expected = ["run-as-node=unset", "arg=--component-shot", `arg=${folder}`, "arg=--out", "arg=/tmp/out dir", "arg=--theme", "arg=light"];

  it("is a space-free path, in the home folder because the data folder has a space", () => {
    expect(command).toBe(join(root, "home", ".botling", "bin", SHOT_WRAPPER));
    expect(UNQUOTED_SAFE.test(command)).toBe(true);
  });

  for (const [name, path] of shells) {
    it.skipIf(!path)(`$BOTLING_SHOT_COMMAND <folder> --out <dir> runs in ${name}, the binary's own path having a space and a quote`, () => {
      const env = { ...process.env, BOTLING_SHOT_COMMAND: command, ELECTRON_RUN_AS_NODE: "1" };
      const printed = execFileSync(path!, ["-c", `$BOTLING_SHOT_COMMAND "${folder}" --out "/tmp/out dir" --theme light`], { env, encoding: "utf8" });
      expect(printed.trimEnd().split("\n")).toEqual(expected);
    });
  }

  it.skipIf(!shellPath("zsh"))("the old command string is what failed in zsh: one word, so no such file or directory", () => {
    const old = `env -u ELECTRON_RUN_AS_NODE '${binary}' --component-shot`;
    const run = spawnSync(shellPath("zsh")!, ["-c", `$BOTLING_SHOT_COMMAND x`], { env: { ...process.env, BOTLING_SHOT_COMMAND: old }, encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/no such file or directory|command not found/i);
  });
});

describe("the packaged botlingd", () => {
  it("hands the core a script path for the shot and keeps the other two commands as they were", () => {
    const root = tempDir("shot-wrapper-v3");
    const execPath = "/Applications/Botling 3.app/Contents/MacOS/Botling 3";
    const env: Record<string, string | undefined> = {};
    setPackagedSelfCommands(env, execPath, [join(root, "bin")]);
    expect(env.BOTLING_SHOT_COMMAND).toBe(join(root, "bin", SHOT_WRAPPER));
    expect(readFileSync(env.BOTLING_SHOT_COMMAND!, "utf8")).toContain(`'${execPath}' --component-shot "$@"`);
    expect(env.BOTLING_CHECK_COMMAND).toBe(`env -u ELECTRON_RUN_AS_NODE '${execPath}' --check-plugin`);
  });
});
