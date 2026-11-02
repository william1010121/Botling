// botling.dev's program part: the tags and the developer project's changes drive the same swap steps the core used to (swap.test.ts
// holds those steps): the card, the install script and its state, `installAndRestart`, the screenshot, the briefing's bytes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../../test/helpers";
import type { AppState, BotInfo, ReplyTag } from "../../../../Web/host/src/api";
import { DevBuilds } from "../src/desk";
import { DEVELOPER_OFF_NOTE, Program, type ProgramApi } from "../src/program";
import { installOutcome, prepareInstall, readBuild, setFailures } from "../src/swap";

const BUNDLE_ID = "io.github.william1010121.Botling2";
function fakeApp(dir: string, name: string, info: Record<string, string> = {}): string {
  const app = join(dir, `${name}.app`);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  const all = { CFBundleIdentifier: BUNDLE_ID, CFBundleExecutable: "Botling 2", CFBundleShortVersionString: "2.0.1", ...info };
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
${Object.entries(all).map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`).join("\n")}
</dict></plist>`);
  writeFileSync(join(app, "Contents", "MacOS", all.CFBundleExecutable), "#!/bin/sh\n");
  chmodSync(join(app, "Contents", "MacOS", all.CFBundleExecutable), 0o755);
  return app;
}

const DEV: BotInfo = { id: "DEV", name: "botling", role: "manager", awake: true };
const GARDEN: BotInfo = { id: "GARDEN", name: "garden", role: "manager", awake: true };
const WORKER: BotInfo = { id: "W", name: "helper", role: "bot", awake: true };

function setup(root: string, over: Partial<AppState> = {}) {
  const running = fakeApp(join(root, "Applications"), "Botling 2", { BotlingGitCommit: "aaaaaaa1111" });
  const state: AppState = {
    pid: 4242, dataDir: join(root, "core"), appDataDir: join(root, "data"), bundle: running, developerMode: true,
    developer: { id: "DEV", name: "botling", folder: join(root, "repo") }, ...over,
  };
  const calls: any[] = [];
  const picks: ((index: number) => void)[] = [];
  const handlers = new Map<string, (data: any) => void>();
  const tags = new Map<string, (tag: ReplyTag) => void>();
  const api: ProgramApi = {
    subscriptions: [],
    bots: { list: async () => [DEV, GARDEN, WORKER] } as never,
    events: { on: (event: string, fn: (data: any) => void) => { handlers.set(event, fn); return () => {}; } } as never,
    replyTags: { on: (tag: string, fn: (tag: ReplyTag) => void) => { tags.set(tag, fn); return () => {}; } },
    app: {
      state: async () => state,
      installAndRestart: async (command, log) => { calls.push(["install", command, log]); },
      captureWindow: async () => join(root, "shot.png"),
      card: (text, opts) => new Promise((resolve) => { calls.push(["card", text, opts?.choices, opts?.source]); if (opts?.choices) picks.push(resolve); else resolve(null); }),
      tell: async (bot, kind, text, files) => { calls.push(["tell", bot, kind, text, files]); },
      briefing: async (briefing) => { calls.push(["briefing", briefing]); },
    },
  };
  const program = new Program(api, { healthyAfterMs: 8_000, devWork: () => "/Volumes/Work/botling-work" });
  const tag = (name: string, bot: BotInfo, attributes: Record<string, string> = {}, body = "") => tags.get(name)!({ bot, tag: name, attributes, body });
  return { program, calls, picks, state, running, tag, handlers, api };
}

afterEach(() => { vi.useRealTimers(); });

describe("the developer project's briefing", () => {
  it("is published with the same bytes DevBuilds gave (plain and for a worktree), and withdrawn when there is no developer project", async () => {
    const root = tempDir("dev-plugin");
    const { program, calls, state } = setup(root);
    await program.start();
    const reference = new DevBuilds({ developer: () => ({ id: "DEV" }), devWork: () => "/Volumes/Work/botling-work" } as never);
    const bot = { id: "DEV", profile: { folder: join(root, "repo") } } as never;
    expect(calls.find((call) => call[0] === "briefing")![1]).toEqual({ bot: "DEV", plain: reference.briefing(bot, false), worktree: reference.briefing(bot, true) });
    expect(reference.briefing(bot, false)).toMatch(/<install-build path=/);
    state.developer = null;
    await program.publishBriefing();
    expect(calls.at(-1)).toEqual(["briefing", null]);
  });
});

describe("<install-build> from a bot's reply", () => {
  it("only the developer project's manager is offered a card; a worker is ignored, another manager is told it needs developer mode", async () => {
    const root = tempDir("dev-plugin");
    const { program, calls, tag } = setup(root);
    await program.start();
    calls.length = 0;
    const built = fakeApp(join(root, "dist"), "Botling 2", { BotlingGitCommit: "bbbbbbb2222" });
    tag("install-build", WORKER, { path: built });
    tag("install-build", DEV, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
    tag("install-build", GARDEN, { path: built });
    await vi.waitFor(() => expect(calls.at(-1)).toEqual(["tell", "GARDEN", "note", expect.stringMatching(/needs developer mode/), undefined]));
  });

  it("a confirmed card writes the script and starts it through the app; Not now starts nothing", async () => {
    const root = tempDir("dev-plugin");
    const { program, calls, picks, running, tag } = setup(root);
    await program.start();
    const built = fakeApp(join(root, "dist"), "Botling 2", { BotlingGitCommit: "bbbbbbb2222" });
    tag("install-build", DEV, { path: built }, "Faster startup.");
    await vi.waitFor(() => expect(picks).toHaveLength(1));
    const card = calls.find((call) => call[0] === "card")!;
    expect(card[1]).toContain(`Installed in place: ${running}`);
    expect(card[1]).toContain("Faster startup.");
    expect(card[2]).toEqual([{ label: "Install and restart", recommended: true }, { label: "Not now" }]);
    expect(card[3]).toBe("DEV");
    picks[0]!(1);
    await vi.waitFor(() => expect(calls.at(-1)).toEqual(["tell", "DEV", "note", expect.stringMatching(/chose not to install/), undefined]));
    expect(calls.some((call) => call[0] === "install")).toBe(false);

    tag("install-build", DEV, { path: built }, "Faster startup.");
    await vi.waitFor(() => expect(picks).toHaveLength(2));
    picks[1]!(0);
    await vi.waitFor(() => expect(calls.some((call) => call[0] === "install")).toBe(true));
    const [, command, log] = calls.find((call) => call[0] === "install")!;
    expect(command.slice(0, 3)).toEqual(["/usr/bin/nohup", "/bin/bash", join(root, "core", "self-update", "install.sh")]);
    expect(command.slice(3, 6)).toEqual(["4242", running, built]);
    expect(command[10]).toBe(join(root, "data"));
    expect(log).toBe(join(root, "core", "self-update", "install.log"));
    expect(installOutcome(join(root, "core"))).toMatchObject({ kind: "installed", state: { requesterID: "DEV", note: "Faster startup." } });
  });

  it("a build that is refused (the running one, paused after failures) is said in the main bot's chat and to the bot", async () => {
    const root = tempDir("dev-plugin");
    const { program, calls, running, tag } = setup(root);
    await program.start();
    calls.length = 0;
    tag("install-build", DEV, { path: running });
    await vi.waitFor(() => expect(calls.map((call) => call[0])).toEqual(["card", "tell"]));
    expect(calls[0][1]).toMatch(/that is the build running now/);
    expect(calls[0][3]).toBe("DEV");
    expect(calls[1]).toEqual(["tell", "DEV", "note", expect.stringMatching(/^\(App: The build was not installed:/), undefined]);
    setFailures(join(root, "core"), 2);
    calls.length = 0;
    tag("install-build", DEV, { path: fakeApp(join(root, "dist"), "Botling 2") });
    await vi.waitFor(() => expect(calls[0]?.[1]).toMatch(/installing is paused/));
  });
});

describe("<app-screenshot/> from a bot's reply", () => {
  it("the developer project's manager gets the picture back as a relay line; another manager is told", async () => {
    const root = tempDir("dev-plugin");
    const { program, calls, tag } = setup(root);
    await program.start();
    calls.length = 0;
    tag("app-screenshot", WORKER);
    tag("app-screenshot", DEV);
    await vi.waitFor(() => expect(calls).toEqual([["tell", "DEV", "relay", "(App) The app's window right now.", [join(root, "shot.png")]]]));
    tag("app-screenshot", GARDEN);
    await vi.waitFor(() => expect(calls.at(-1)).toEqual(["tell", "GARDEN", "note", expect.stringMatching(/need developer mode/), undefined]));
  });
});

describe("after the restart", () => {
  it("tells the bot that asked how the install went, once the new build has run long enough; the core wrote `healthy`, the plugin only finishes", async () => {
    vi.useFakeTimers();
    const root = tempDir("dev-plugin");
    const { program, calls, running } = setup(root);
    const to = readBuild(fakeApp(join(root, "dist"), "Botling 2", { BotlingGitCommit: "bbbbbbb2222" }))!;
    prepareInstall(join(root, "core"), readBuild(running)!, to, "DEV", "Faster startup.", 1, "");
    await program.start();
    expect(calls.filter((call) => call[0] === "card")).toEqual([]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(existsSync(join(root, "core", "self-update", "healthy"))).toBe(false);
    expect(installOutcome(join(root, "core"))).toBeNull();
    expect(calls.find((call) => call[0] === "card")![1]).toBe("Botling restarted on 2.0.1 (bbbbbbb) (was 2.0.1 (aaaaaaa)), installed for botling.");
    expect(calls.find((call) => call[2] === "relay")![3]).toMatch(/^\(App\) Botling restarted on 2\.0\.1 \(bbbbbbb\), the build you asked to install \(Faster startup\.\)/);
  });
});

describe("the developer project changing", () => {
  it("developer mode turned on again clears the failures; the new project hears its briefing and the old one that it is off", async () => {
    const root = tempDir("dev-plugin");
    const { program, calls, state, handlers } = setup(root);
    await program.start();
    setFailures(join(root, "core"), 2);
    calls.length = 0;
    state.developer = { id: "GARDEN", name: "garden", folder: join(root, "garden") };
    handlers.get("developerChanged")!({ before: "DEV", now: "GARDEN", turnedOn: true });
    await vi.waitFor(() => expect(calls.filter((call) => call[0] === "tell")).toHaveLength(2));
    expect(existsSync(join(root, "core", "self-update", "failures"))).toBe(true);
    expect(readFailures(root)).toBe("0");
    expect(calls.find((call) => call[0] === "briefing")![1].bot).toBe("GARDEN");
    const notes = calls.filter((call) => call[0] === "tell");
    expect(notes[0]).toEqual(["tell", "GARDEN", "note", expect.stringMatching(/^\(App: Developer mode\. This folder is Botling's own source/), undefined]);
    expect(notes[1]).toEqual(["tell", "DEV", "note", DEVELOPER_OFF_NOTE, undefined]);
  });
});

import { readFileSync } from "node:fs";
function readFailures(root: string) { return readFileSync(join(root, "core", "self-update", "failures"), "utf8").trim(); }
