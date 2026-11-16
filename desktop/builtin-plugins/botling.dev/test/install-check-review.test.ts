// Review probes for the install-result check (bot/v3-install-check): the pick refuses a bundle that is gone or is another
// app since the card, the asar hash is taken again when the file changes, and the hash comparison does not pass on a missing
// or empty hash.
import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../../test/helpers";
import type { AppState, BotInfo, ReplyTag } from "../../../../Web/host/src/api";
import { Program, type ProgramApi } from "../src/program";
import { asarSha256, installOutcome, readBuild, whichBuild } from "../src/swap";

const DEV: BotInfo = { id: "DEV", name: "botling", role: "manager", awake: true };
const T0 = 1_800_000_000;

function fakeApp(dir: string, info: Record<string, string>, asar: string, seconds: number): string {
  const app = join(dir, "Botling 3.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  writeInfo(app, info);
  writeFileSync(join(app, "Contents", "MacOS", "Botling 3"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(app, "Contents", "MacOS", "Botling 3"), 0o755);
  setAsar(app, asar, seconds);
  return app;
}
function writeInfo(app: string, info: Record<string, string>) {
  const all = { CFBundleIdentifier: "io.github.william1010121.Botling3", CFBundleExecutable: "Botling 3", CFBundleShortVersionString: "3.0.0-beta.1", BotlingGitCommit: "c8d10570aaaa", BotlingGitDirty: "1", ...info };
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n${Object.entries(all).map(([key, value]) => `  <key>${key}</key><string>${value}</string>`).join("\n")}\n</dict></plist>`);
}
function setAsar(app: string, content: string, seconds: number) {
  const file = join(app, "Contents", "Resources", "app.asar");
  writeFileSync(file, content);
  utimesSync(file, seconds, seconds);
}

async function cardFor(root: string, dist: string) {
  const old = fakeApp(join(root, "Applications"), { BotlingGitCommit: "aaaaaaa1111" }, "old build", T0);
  const state: AppState = { pid: 4242, dataDir: join(root, "core"), appDataDir: join(root, "data"), bundle: old, developerMode: true, developer: { id: "DEV", name: "botling", folder: join(root, "repo") } };
  const calls: any[] = [];
  const picks: ((index: number) => void)[] = [];
  const tags = new Map<string, (tag: ReplyTag) => void>();
  const api: ProgramApi = {
    subscriptions: [],
    bots: { list: async () => [DEV] } as never,
    events: { on: () => () => {} } as never,
    replyTags: { on: (tag: string, fn: (tag: ReplyTag) => void) => { tags.set(tag, fn); return () => {}; } },
    app: {
      state: async () => state,
      installAndRestart: async (command, log) => { calls.push(["install", command, log]); },
      captureWindow: async () => null,
      card: (text, opts) => new Promise((resolve) => { calls.push(["card", text]); if (opts?.choices) picks.push(resolve); else resolve(null); }),
      tell: async (bot, kind, text) => { calls.push(["tell", bot, kind, text]); },
      briefing: async () => {},
    },
  };
  await new Program(api, { healthyAfterMs: 20, devWork: () => null }).start();
  tags.get("install-build")!({ bot: DEV, tag: "install-build", attributes: { path: dist }, body: "x" });
  await waitFor(() => picks.length === 1);
  const pick = async () => {
    picks[0]!(0);
    await waitFor(() => calls.filter((call) => call[0] === "card").length === 2 || calls.some((call) => call[0] === "install"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { installed: calls.some((call) => call[0] === "install"), text: calls.filter((call) => call[0] === "card" || call[0] === "tell").map((call) => String(call[call[0] === "card" ? 1 : 3])).join("\n") };
  };
  return { pick };
}
async function waitFor(check: () => boolean, ms = 3_000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

describe("the pick re-reads the build", () => {
  it("a bundle removed since the card is refused, nothing is installed", async () => {
    const root = tempDir("install-review");
    const dist = fakeApp(join(root, "dist"), {}, "build one", T0 + 100);
    const { pick } = await cardFor(root, dist);
    rmSync(dist, { recursive: true, force: true });
    const result = await pick();
    expect(result.installed).toBe(false);
    expect(result.text).toMatch(/no app bundle at/);
    expect(installOutcome(join(root, "core"))).toBeNull();
  });

  it("a bundle that became another app (same label, other bundle id) since the card is refused", async () => {
    const root = tempDir("install-review");
    const dist = fakeApp(join(root, "dist"), {}, "build one", T0 + 100);
    const { pick } = await cardFor(root, dist);
    writeInfo(dist, { CFBundleIdentifier: "io.github.william1010121.Botling2" });
    const result = await pick();
    expect(result.installed).toBe(false);
    expect(installOutcome(join(root, "core"))).toBeNull();
  });
});

describe("asar hash", () => {
  it("is taken again when the file at the same path changes (same size), and is null without an asar", () => {
    const root = tempDir("install-review");
    const app = fakeApp(root, {}, "aaaa", T0);
    const first = asarSha256(app);
    setAsar(app, "bbbb", T0 + 10);
    const second = asarSha256(app);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    rmSync(join(app, "Contents", "Resources", "app.asar"));
    expect(asarSha256(app)).toBeNull();
  });
});

describe("whichBuild with hashes", () => {
  it("an empty recorded hash never matches the running bundle, even with the same label and time", () => {
    const root = tempDir("install-review");
    const running = readBuild(fakeApp(root, {}, "what runs", T0))!;
    expect(whichBuild(running, { from: { ...running, commit: "ffff" }, to: { ...running, asarSha256: "" } })).toBe("other");
  });

  it("an old state without hashes falls back to the time (same label, other time: not the requested build)", () => {
    const root = tempDir("install-review");
    const running = readBuild(fakeApp(root, {}, "what runs", T0))!;
    expect(whichBuild(running, { from: { ...running, builtAt: 1 }, to: { ...running, builtAt: running.builtAt! + 60_000 } })).toBe("other");
    expect(whichBuild(running, { from: { ...running, builtAt: 1 }, to: { ...running } })).toBe("to");
  });
});
