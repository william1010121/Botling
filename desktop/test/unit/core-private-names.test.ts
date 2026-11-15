// M7-S61: the private names of `Core` (core/server.ts) that tests and spec adapters reach by casting (`(core as any).bots`), and
// the public ones other code calls. The cards that cut `Core` (M7-S16 and after) keep every one of them reachable on `Core` itself
// (an accessor or a delegate), because those tests and `desktop/spec-adapters/` are not changed by the split. Found by reading
// every `as any` / `as unknown as {…}` cast on a core in `desktop/test`, `desktop/spec-adapters` and `desktop/src`:
//   bots, conversations, activated, handle           spec-adapters/relayed-card-adapter.ts, callin-adapter.ts
//   send, replied, event, bot, agents, plugins       agent-*-server, core-fixed-ids, designated-main, plugin-server-part-grant tests
//   subBotRequested, subBotReplied, subBotNote       sub-bots.test.ts, agent-group-server.test.ts
//   showOpenQuestion, calledInPick, ignoreQuestion   question-ignore, callin-reply-settle, callin-late tests
//   reconcileAgents, projectRequests, profiles, order, maintainer, lastPlugins, ...
// Only a name that some file outside `core/server.ts` reaches (tests, spec adapters, product code) or that `core-split-characterization.test.ts`
// reads is listed: a name nothing reaches is free to move into a collaborator without an accessor (review of M7-S61 dropped
// `agentReconcile`, `answerOnCopy`, `closeCopiesOf`, `componentsTick`, `mobileDesk`, `movingSubagents`, `pickOnCopy`, `pluginStore`, `scanComponents`, `serverAsks`).
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import { coreProcessOptions } from "../../src/core/core-process";
import { fakeCli, tempDir } from "../helpers";

const METHODS = [
  "activate", "agentMessageCommand", "agentStopCommand", "agentTag", "agentView", "attach", "bot", "calledInPick", "event", "finishMove", "handle", "ignoreQuestion",
  "makeSubBot", "moveOwners", "ownedAgentsNote", "projectRequests", "reconcileAgents", "removeBot", "removeBotRequested", "removeSubBotRequested", "replied", "send", "showOpenQuestion",
  "studioNow", "subBotNote", "subBotReplied", "subBotRequested", "workspaceSource",
];
/** Fields and accessors: `in` finds an own field, an inherited one and an accessor alike. */
const FIELDS = [
  "activated", "agents", "bots", "conversations", "copies", "inflight", "lastPlugins", "libraryWatch", "maintainer", "memoryWatch", "options", "order",
  "plugins", "profiles", "relay", "removed", "restarting", "routineClock", "subBotsReported", "swapping", "waitingTimer", "watchClock",
];
/** What other code calls on a `Core` without a cast. */
const PUBLIC = [
  "agentTargets", "attachMobile", "attachRelay", "cancelRestart", "cancelSwap", "closeSubBot", "deliverInboxes", "drainForSwap", "groupAgents", "ignoreWaiting", "mainBot",
  "mobileCommand", "moveAgent", "prepareQuitContinuation", "prepareRestart", "receive", "shutdown", "snapshot", "waiting",
];
const PUBLIC_FIELDS = ["doctor", "epoch", "maintainerId", "mainBotId", "pending", "releases", "storage"];
/** What a plugin's world gives (`core.plugins.options.world`), reached by tests through two casts. */
const WORLD = ["addRoutine", "botId", "bots", "chat", "routinesList", "send"];

const opened: Core[] = [];
afterEach(async () => { for (const core of opened.splice(0)) await core.shutdown().catch(() => {}); });

function open(): Core {
  const dir = tempDir("core-names");
  const env = { BOTLING_AGENT: "fake", BOTLING_FAKE_CLI: fakeCli, BOTLING_COMPONENT_SCAN_MS: "0", BOTLING_WAITING_SCAN_MS: "0", BOTLING_ROUTINE_TICK_MS: "0", BOTLING_WATCH_MS: "0", BOTLING_QUIT_TIDY_MS: "0", BOTLING_UPDATE_PENDING: "1" };
  const base = coreProcessOptions({ env, dataDir: dir, outDir: join(dir, "unused-out"), emit: () => {}, log: () => {}, node: null, sealer: null, app: null });
  const core = new Core({ ...base, plugins: null });
  opened.push(core);
  return core;
}

describe("the private names of Core that tests and spec adapters reach", () => {
  it("every method is still a method of Core", () => {
    const core = open() as any;
    expect(METHODS.filter((name) => typeof core[name] !== "function")).toEqual([]);
  });
  it("every field is still reachable on Core", () => {
    const core = open() as any;
    expect(FIELDS.filter((name) => !(name in core))).toEqual([]);
  });
  it("the fields hold what the tests and adapters take them for", () => {
    const core = open() as any;
    expect(core.bots).toBeInstanceOf(Map);
    expect(core.bots.get(core.mainBotId)).toBeTruthy();
    expect(core.order).toEqual([...core.bots.keys()].filter((id: string) => core.order.includes(id)));
    expect(core.profiles.map((profile: any) => profile.id)).toEqual(expect.arrayContaining([core.mainBotId, core.maintainerId]));
    expect(core.options.dataDir).toEqual(expect.any(String));
    expect(core.conversations.isCalledIn).toBeInstanceOf(Function);
    expect(core.agents.reconcile).toBeInstanceOf(Function);
    expect([core.activated, core.swapping, core.restarting, typeof core.lastPlugins]).toEqual([false, false, false, "string"]);
    for (const name of ["inflight", "removed", "copies", "subBotsReported"]) expect([name, typeof core[name]?.size]).toEqual([name, "number"]);
    for (const name of ["routineClock", "watchClock", "libraryWatch", "memoryWatch", "waitingTimer", "relay"]) expect([name, core[name]]).toEqual([name, null]);
  });
  it("the public surface other code calls is still there", () => {
    const core = open() as any;
    expect(PUBLIC.filter((name) => typeof core[name] !== "function")).toEqual([]);
    expect(PUBLIC_FIELDS.filter((name) => !(name in core))).toEqual([]);
  });
  it("a plugin's world still has the calls the tests reach through `plugins.options.world`", () => {
    const core = open() as any;
    const world = core.plugins.options.world;
    expect(WORLD.filter((name) => typeof world[name] !== "function")).toEqual([]);
    expect(typeof world.app).toBe("object");
  });
});
