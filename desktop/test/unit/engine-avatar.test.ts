// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEnvelope, type BotView, type ResultOf } from "../../src/contract";
import { WorkspaceStore } from "../../src/renderer/store";
import { chatState } from "../../src/renderer/payload";
import { avatarURL, characterURL, faceURL } from "../../src/renderer/avatars";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const bot: BotView = { id: "B", name: "Main", role: "main", avatar: "square", folder: "/w", phase: "starting", working: true, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude", "codex"], job: null, subagentRows: [] };
const empty = (): ResultOf<"chat.snapshot"> => ({
  epoch: "epoch", seq: 0, bots: [bot], imported: null, components: {}, plugins: { plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null },
  chat: { botId: bot.id, messages: [], running: null, live: [], tasks: [], runs: [], heads: null, catchUp: null, intervalSummaries: [], pins: [], floating: [], pinChoices: [] },
});
const face = (engine: string, working = false, waiting = false) => faceURL(bot, "cute", { engine, working, waiting });
const draw = (store: WorkspaceStore, look: "cute" | "original" = "cute") => {
  const view = store.getView();
  const state = chatState(view.bots[0], view.chat!, new Date(), null, { look }).state;
  window.ccb.setState(state);
  return state;
};
const typingFace = () => document.querySelector<HTMLElement>("#messages > .row.typing")?.dataset.avatar;
const messageFace = (id: string) => document.querySelector<HTMLImageElement>(`#messages [data-id="${id}"] > .avatar`)?.getAttribute("src");

beforeAll(async () => {
  // Real bundled art makes Claude/Codex/Antigravity and their moods observably distinct in the rendered DOM.
  const art = join(__dirname, "../../assets/avatars-static");
  vi.stubGlobal("__CHARACTERS__", Object.fromEntries(["claude", "gpt", "gemini"].map((engine) => [engine, Object.fromEntries(["idle", "working", "thinking", "sleepy"].map((mood) => [mood, readFileSync(join(art, engine, `${mood}.png`)).toString("base64")]))])));
  document.body.innerHTML = '<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>';
  await import("../../../Web/src/main");
});
afterEach(() => window.ccb.setState(chatState(bot, empty().chat!).state));

describe("assistant engine avatars before the first token", () => {
  it.each(["claude", "codex", "agy"] as const)("renders the submitted %s turn immediately, through waiting, steps and streaming", async (head) => {
    const store = new WorkspaceStore(async () => empty());
    await store.resync();
    let seq = 0;
    const send = (event: unknown) => store.receive(EventEnvelope.parse({ v: 10, epoch: "epoch", seq: ++seq, event }));
    send({ type: "turn.started", botId: bot.id, turnId: "turn", messageId: "reply", head });
    expect(draw(store).messages).toEqual([]);
    expect(typingFace()).toBe(face(head, true));
    // A selector change while this turn waits must not change its identity.
    send({ type: "bot.updated", bot: { ...bot, heads: [head === "codex" ? "claude" : "codex"], phase: "awake", approvals: 1 } });
    draw(store);
    expect(typingFace()).toBe(face(head, true, true));
    send({ type: "turn.steps", botId: bot.id, turnId: "turn", messageId: "reply", steps: [{ id: "tool", kind: "tool", title: "Read", tool: "Read", detail: null, output: null, failed: false, done: false }] });
    expect(draw(store).live?.[0].title).toBe("Read");
    expect(typingFace()).toBe(face(head, true, true));
    send({ type: "message.added", botId: bot.id, message: { id: "reply", role: "bot", text: "", time: new Date().toISOString(), state: "streaming", engine: head } });
    draw(store);
    expect(typingFace()).toBe(face(head, true, true));
    send({ type: "turn.delta", botId: bot.id, turnId: "turn", messageId: "reply", text: "First token" });
    draw(store);
    expect(messageFace("reply")).toBe(face(head));
    expect(typingFace()).toBe(face(head, true, true));
    send({ type: "turn.finished", botId: bot.id, turnId: "turn", messageId: "reply", status: "done", text: "First token" });
    draw(store);
    expect(messageFace("reply")).toBe(face(head));
    expect(typingFace()).toBeUndefined();
  });

  it("keeps snapshot and concurrent turn heads separate when the displayed turn finishes", async () => {
    const snapshot = empty();
    snapshot.chat!.running = { turnId: "x", messageId: "rx" };
    snapshot.chat!.runs = [{ turnId: "x", messageId: "rx", head: "codex", live: [] }, { turnId: "c", messageId: "rc", head: "claude", live: [] }];
    const store = new WorkspaceStore(async () => snapshot);
    await store.resync();
    draw(store);
    expect(typingFace()).toBe(face("codex", true));
    store.receive({ v: 10, epoch: "epoch", seq: 1, event: { type: "turn.finished", botId: bot.id, turnId: "x", messageId: "rx", status: "done", text: "Done" } });
    draw(store);
    expect(typingFace()).toBe(face("claude", true));
  });

  it("keeps historical identity independent of current heads, including legacy Claude messages", async () => {
    const snapshot = empty();
    snapshot.bots = [{ ...bot, heads: ["codex"] }];
    snapshot.chat!.messages = [
      { id: "legacy", role: "bot", text: "Before engine metadata", time: new Date().toISOString() },
      ...(["claude", "codex", "agy"] as const).map((engine) => ({ id: engine, role: "bot" as const, text: "Saved reply", time: new Date().toISOString(), engine })),
    ];
    const store = new WorkspaceStore(async () => snapshot);
    await store.resync();
    draw(store);
    expect(messageFace("legacy")).toBe(face("claude"));
    expect(messageFace("claude")).toBe(face("claude"));
    expect(messageFace("codex")).toBe(face("codex"));
    expect(messageFace("agy")).toBe(face("agy"));
    // Original look keeps the bot's established shape for every engine.
    draw(store, "original");
    for (const id of ["legacy", "claude", "codex", "agy"]) expect(messageFace(id)).toBe(avatarURL(bot.avatar));
  });
});

describe("Antigravity illustrated look", () => {
  it.each([
    ["normal", "idle", {}], ["work", "working", { working: true }],
    ["think", "thinking", { working: true, waiting: true }],
    ["sleep", "sleepy", { asleep: true, working: true, waiting: true }],
  ] as const)("uses the supplied Gemini %s illustration and preserves the bot shape", (mood, asset, state) => {
    const art = readFileSync(join(__dirname, "../../assets/avatars-static/gemini", `${asset}.png`)).toString("base64");
    const illustrated = characterURL("agy", mood, "octagon");
    expect(atob(illustrated.split(",")[1])).toContain(`href="data:image/png;base64,${art}"`);
    expect(illustrated).toBe(characterURL("gemini", mood, "octagon"));
    expect(faceURL({ avatar: "octagon", heads: ["agy"] }, "cute", state)).toBe(illustrated);
    expect(faceURL({ avatar: "octagon", heads: ["agy"] }, "original", state)).toBe(avatarURL("octagon", "asleep" in state ? "closed" : "open"));
    expect(characterURL("agy", mood, "heart")).not.toBe(illustrated);
    expect(atob(characterURL("agy", mood).split(",")[1])).not.toContain('width="19"');
  });
});
