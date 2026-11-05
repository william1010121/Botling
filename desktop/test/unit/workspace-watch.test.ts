// The workspace's change watch (core/workspace.ts, `workspace.onChange` for plugins): it tells only
// while someone listens, only what changed since the last thing told (or since listening began),
// and its stamp moves exactly when it tells. The protocol is spec/models/workspace.
import { describe, expect, it } from "vitest";
import { currentChat, WorkspaceWatch, type WorkspaceDigest } from "../../src/core/workspace";

const digest = (bots: Record<string, Partial<Record<"bots" | "tasks" | "memory" | "waiting" | "results" | "current", string>>>): WorkspaceDigest => bots;

describe("WorkspaceWatch", () => {
  it("tells nothing before someone listens, and takes what is there then as what they may have read", () => {
    const watch = new WorkspaceWatch("e1");
    expect(watch.watching).toBe(false);
    expect(watch.check(digest({ a: { tasks: "1" } }))).toBeNull();
    watch.start(digest({ a: { tasks: "1" }, b: { memory: "x" } }));
    expect(watch.watching).toBe(true);
    expect(watch.stamp).toBe("e1:0");
    expect(watch.check(digest({ a: { tasks: "1" }, b: { memory: "x" } }))).toBeNull();
    expect(watch.stamp).toBe("e1:0");
  });

  it("names the bots and kinds that changed; a bot that came or went changes every kind it has", () => {
    const watch = new WorkspaceWatch("e1");
    watch.start(digest({ a: { bots: "A", tasks: "1" }, b: { bots: "B", memory: "x" } }));
    expect(watch.check(digest({ a: { bots: "A", tasks: "2" }, b: { bots: "B", memory: "x" } }))).toEqual({ stamp: "e1:1", botIds: ["a"], kinds: ["tasks"] });
    expect(watch.check(digest({ a: { bots: "A", tasks: "2" }, c: { bots: "C", waiting: "w" } }))).toEqual({ stamp: "e1:2", botIds: ["b", "c"], kinds: ["bots", "memory", "waiting"] });
    // The same again: nothing to tell, the stamp stays.
    expect(watch.check(digest({ a: { bots: "A", tasks: "2" }, c: { bots: "C", waiting: "w" } }))).toBeNull();
    expect(watch.stamp).toBe("e1:2");
  });

  it("forgets what it saw when nobody listens any more; listening again starts from what is there then", () => {
    const watch = new WorkspaceWatch("e1");
    watch.start(digest({ a: { tasks: "1" } }));
    watch.stop();
    expect(watch.watching).toBe(false);
    expect(watch.check(digest({ a: { tasks: "2" } }))).toBeNull();
    watch.start(digest({ a: { tasks: "3" } }));
    expect(watch.check(digest({ a: { tasks: "3" } }))).toBeNull();
    // Starting while already listening keeps the earlier baseline (nothing in between is lost).
    watch.start(digest({ a: { tasks: "4" } }));
    expect(watch.check(digest({ a: { tasks: "4" } }))).toEqual({ stamp: "e1:1", botIds: ["a"], kinds: ["tasks"] });
  });
});

describe("the chat open in the main window (workspace.current)", () => {
  it("gives the primary head's session first, null before it started; a tab only with view \"tab\"", () => {
    const heads = [{ engine: "claude" as const, sessionId: null }, { engine: "codex" as const, sessionId: "T1" }];
    expect(currentChat({ botId: "B1", view: "tab", tab: "p/v" }, "B1", "codex", heads)).toEqual({
      botId: "B1", engine: "codex", sessionId: "T1", heads: [{ engine: "codex", sessionId: "T1" }, { engine: "claude", sessionId: null }], view: "tab", tab: "p/v",
    });
    expect(currentChat({ botId: "M", view: "board", tab: "p/v" }, "main", "claude", heads)).toMatchObject({ botId: "main", engine: "claude", sessionId: null, view: "board", tab: null });
    expect(currentChat({ botId: "M", view: "chat", tab: null }, "main", "agy", [])).toMatchObject({ engine: "agy", sessionId: null, heads: [] });
  });

  it("a switch is told as kind \"current\", naming the bot left and the bot opened", () => {
    const watch = new WorkspaceWatch("e1");
    watch.start(digest({ a: { bots: "A", current: "a-chat" }, b: { bots: "B" } }));
    expect(watch.check(digest({ a: { bots: "A" }, b: { bots: "B", current: "b-chat" } }))).toEqual({ stamp: "e1:1", botIds: ["a", "b"], kinds: ["current"] });
    expect(watch.check(digest({ a: { bots: "A" }, b: { bots: "B", current: "b-board" } }))).toEqual({ stamp: "e1:2", botIds: ["b"], kinds: ["current"] });
  });
});
