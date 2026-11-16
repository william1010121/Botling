// The install-result check judged equal builds as different (2026-11-16, three times: "Botling is running 3.0.0-beta.1
// (c8d1057, uncommitted changes), which is neither the old build (…) nor the requested one", the running label being the
// requested label). The check compared when the app.asar was written (`builtAt`), and the requested build had been read at
// card time: a rebuild of the same commit between the card and the pick (or a copy that did not keep the time) made the build
// that really came up look like another one. These tests run the whole path (the tag, the card, the pick, the script's
// state, the next start's verdict) and pin: the installed build is the one the install started with (its content decides, not
// a time), the old build is what really runs (not the bundle on disk now), and a build that changed since the card is refused.
import { describe, expect, it } from "vitest";
import { chmodSync, copyFileSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../../test/helpers";
import type { AppState, BotInfo, ReplyTag } from "../../../../Web/host/src/api";
import { Program, type ProgramApi } from "../src/program";
import { installOutcome } from "../src/swap";

const BUNDLE_ID = "io.github.william1010121.Botling3";
const DEV: BotInfo = { id: "DEV", name: "botling", role: "manager", awake: true };
const SAME = { BotlingGitCommit: "c8d10570aaaa", BotlingGitDirty: "1" };

function fakeApp(dir: string, name: string, info: Record<string, string>, asar: string, seconds: number): string {
  const app = join(dir, `${name}.app`);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  writeInfo(app, info);
  writeFileSync(join(app, "Contents", "MacOS", "Botling 3"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(app, "Contents", "MacOS", "Botling 3"), 0o755);
  setAsar(app, asar, seconds);
  return app;
}
function writeInfo(app: string, info: Record<string, string>) {
  const all = { CFBundleIdentifier: BUNDLE_ID, CFBundleExecutable: "Botling 3", CFBundleShortVersionString: "3.0.0-beta.1", ...info };
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
${Object.entries(all).map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`).join("\n")}
</dict></plist>`);
}
function setAsar(app: string, content: string, seconds: number) {
  const file = join(app, "Contents", "Resources", "app.asar");
  writeFileSync(file, content);
  utimesSync(file, seconds, seconds);
}
/** What the script's ditto makes: the new build's files in the target folder (the asar time kept, unless `seconds` says otherwise). */
function install(from: string, to: string, seconds?: number) {
  mkdirSync(join(to, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(to, "Contents", "Resources"), { recursive: true });
  for (const file of ["Contents/Info.plist", "Contents/MacOS/Botling 3", "Contents/Resources/app.asar"]) copyFileSync(join(from, file), join(to, file));
  if (seconds !== undefined) utimesSync(join(to, "Contents", "Resources", "app.asar"), seconds, seconds);
  else { const { mtime } = statSync(join(from, "Contents", "Resources", "app.asar")); utimesSync(join(to, "Contents", "Resources", "app.asar"), mtime, mtime); }
  return to;
}

/** One run of the app: a Program on the given bundle, with the app's api recorded. */
function run(root: string, bundle: string) {
  const state: AppState = { pid: 4242, dataDir: join(root, "core"), appDataDir: join(root, "data"), bundle, developerMode: true, developer: { id: "DEV", name: "botling", folder: join(root, "repo") } };
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
      card: (text, opts) => new Promise((resolve) => { calls.push(["card", text, opts?.choices]); if (opts?.choices) picks.push(resolve); else resolve(null); }),
      tell: async (bot, kind, text) => { calls.push(["tell", bot, kind, text]); },
      briefing: async () => {},
    },
  };
  const program = new Program(api, { healthyAfterMs: 20, devWork: () => null });
  const ask = (path: string, note = "Faster startup.") => tags.get("install-build")!({ bot: DEV, tag: "install-build", attributes: { path }, body: note });
  const texts = () => calls.filter((call) => call[0] === "card" || call[0] === "tell").map((call) => String(call[call[0] === "card" ? 1 : 3]));
  const told = async () => { await waitFor(() => calls.some((call) => call[0] === "tell" && call[2] === "relay")); return texts().join("\n---\n"); };
  return { program, calls, picks, state, ask, texts, told };
}
async function waitFor(check: () => boolean, ms = 3_000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
const T0 = 1_800_000_000;

describe("an install is judged by what was installed, with equal labels", () => {
  it("the same commit rebuilt between the card and the pick: the copy that came up is the requested build, not 'neither'", async () => {
    const root = tempDir("install-check");
    const old = fakeApp(join(root, "Applications"), "Botling 3", { ...SAME, BotlingGitCommit: "aaaaaaa1111" }, "old build", T0);
    const dist = fakeApp(join(root, "dist"), "Botling 3", SAME, "build one", T0 + 100);
    const first = run(root, old);
    await first.program.start();
    first.ask(dist);
    await waitFor(() => first.picks.length === 1);
    // The card was made from "build one"; the next build of the same commit (same label) replaced it before the pick.
    setAsar(dist, "build two!", T0 + 1_000);
    first.picks[0]!(0);
    await waitFor(() => first.calls.some((call) => call[0] === "install"));
    expect(installOutcome(join(root, "core"))).toMatchObject({ kind: "installed" });
    // The script copied what was in dist at that time; the new app starts and looks at how the install went.
    const second = run(root, install(dist, join(root, "Applications", "Botling 3 installed.app")));
    await second.program.start();
    const said = await second.told();
    expect(said).toMatch(/restarted on 3\.0\.0-beta\.1 \(c8d1057, uncommitted changes\)/);
    expect(said).not.toMatch(/not installed|neither/);
  });

  it("a copy that lost the asar's time is still the requested build (the content is the same)", async () => {
    const root = tempDir("install-check");
    const old = fakeApp(join(root, "Applications"), "Botling 3", { ...SAME, BotlingGitCommit: "aaaaaaa1111" }, "old build", T0);
    const dist = fakeApp(join(root, "dist"), "Botling 3", SAME, "build one", T0 + 100);
    const first = run(root, old);
    await first.program.start();
    first.ask(dist);
    await waitFor(() => first.picks.length === 1);
    first.picks[0]!(0);
    await waitFor(() => first.calls.some((call) => call[0] === "install"));
    const second = run(root, install(dist, join(root, "Applications", "Botling 3 installed.app"), T0 + 7_200));
    await second.program.start();
    const said = await second.told();
    expect(said).toMatch(/restarted on/);
    expect(said).not.toMatch(/not installed|neither/);
  });

  it("the old build coming back is still 'not installed' when the requested one has its label but other content", async () => {
    const root = tempDir("install-check");
    const old = fakeApp(join(root, "Applications"), "Botling 3", SAME, "old build", T0);
    const dist = fakeApp(join(root, "dist"), "Botling 3", SAME, "build one", T0 + 100);
    const first = run(root, old);
    await first.program.start();
    first.ask(dist);
    await waitFor(() => first.picks.length === 1);
    first.picks[0]!(0);
    await waitFor(() => first.calls.some((call) => call[0] === "install"));
    // The script died before it swapped: the old bundle starts again.
    const second = run(root, old);
    await second.program.start();
    const said = await second.told();
    expect(said).toMatch(/was not installed/);
    expect(said).toMatch(/still running/);
    expect(said).not.toMatch(/restarted on/);
  });
});

describe("the old build is what really runs", () => {
  it("a bundle replaced on disk under the running app does not change what the card and the install call the old build", async () => {
    const root = tempDir("install-check");
    const running = fakeApp(join(root, "Applications"), "Botling 3", { BotlingGitCommit: "8abf3b9aaaa", BotlingGitDirty: "0" }, "what runs", T0);
    const dist = fakeApp(join(root, "dist"), "Botling 3", { BotlingGitCommit: "bbbbbbb2222", BotlingGitDirty: "0" }, "new", T0 + 100);
    const first = run(root, running);
    await first.program.start();
    // Something put another build into the same bundle path while this app kept running (a hot install, a manual copy).
    writeInfo(running, { BotlingGitCommit: "79c4ff9aaaa", BotlingGitDirty: "0" });
    setAsar(running, "another", T0 + 500);
    first.ask(dist);
    await waitFor(() => first.picks.length === 1);
    expect(first.texts().join("\n")).toContain("Running: 3.0.0-beta.1 (8abf3b9)");
    first.picks[0]!(0);
    await waitFor(() => first.calls.some((call) => call[0] === "install"));
    expect(installOutcome(join(root, "core"))?.state.from).toMatchObject({ commit: "8abf3b9aaaa" });
  });
});

describe("the requested build is what the user confirmed", () => {
  it("a build that changed its label since the card is refused, nothing is installed", async () => {
    const root = tempDir("install-check");
    const old = fakeApp(join(root, "Applications"), "Botling 3", { ...SAME, BotlingGitCommit: "aaaaaaa1111" }, "old build", T0);
    const dist = fakeApp(join(root, "dist"), "Botling 3", SAME, "build one", T0 + 100);
    const first = run(root, old);
    await first.program.start();
    first.ask(dist);
    await waitFor(() => first.picks.length === 1);
    writeInfo(dist, { ...SAME, BotlingGitCommit: "d1d1d1d1d1d1" });
    first.picks[0]!(0);
    await waitFor(() => first.calls.filter((call) => call[0] === "card").length === 2 || first.calls.some((call) => call[0] === "install"));
    expect(first.calls.some((call) => call[0] === "install")).toBe(false);
    expect(first.texts().join("\n")).toMatch(/changed since/);
    expect(installOutcome(join(root, "core"))).toBeNull();
  });
});
