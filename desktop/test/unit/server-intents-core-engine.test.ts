// The 2.x core behind the server's TurnEngine (src/server/intents/core-engine.ts), over a stub of the core's surface:
// events and answers share the core's emit; legacy commands go through `receive`; a turn the server starts gets its
// `done` from the core's `deferTurn` call; removing a bot that is gone is not an error.
import { describe, expect, it } from "vitest";
import { ContractError, errorResponse, okResponse, type Event as ContractEvent } from "../../src/contract";
import type { DeferredTurn } from "../../src/core/bot";
import type { DeferredTurnRequest, EngineHost } from "../../src/server/effects";
import { CoreEngine, type CoreLike } from "../../src/server/intents";

function stub(engine: CoreEngine, over: Partial<CoreLike> = {}) {
  const { emit, deferTurn } = engine.coreOptions();
  const received: unknown[] = [];
  const core = {
    hasBot: () => true, botIds: () => ["B1"], pendingFiles: () => 0, checkRemoveBot: () => {}, applyNow: () => ({ changed: true }),
    receive: (raw: unknown) => {
      received.push(raw);
      const { id, cmd } = raw as { id: string; cmd: { type: string } };
      queueMicrotask(() => emit(cmd.type === "files.remove" ? errorResponse(id, { code: "not_found", message: "No such file." }) : okResponse(id, { ran: cmd.type })));
    },
    serverSend: async (botId: string, _text: string, _options: unknown, ids: { turnId: string; messageId: string; userId?: string }) => {
      let finish!: (status: "done") => void;
      const done = new Promise<"done">((resolve) => (finish = resolve));
      const kept = deferTurn({ botId, turnId: ids.turnId, messageId: ids.messageId, userId: ids.userId ?? null, origin: "user", words: "w", engine: "claude", routine: false, done, release: () => ({ turnId: ids.turnId, done }) } as DeferredTurn);
      expect(kept).toBe(false);
      setTimeout(() => finish("done"), 1);
      return { messageId: ids.messageId, turnId: ids.turnId };
    },
    serverTurn: (_botId: string, spec: { ids: { turnId: string } }) => ({ turnId: spec.ids.turnId, done: Promise.resolve("done" as const) }),
    removeBot: async () => { throw new ContractError("not_found", "No such bot."); },
    ...over,
  } as unknown as CoreLike;
  engine.bind(core);
  return { emit, deferTurn, received };
}

describe("CoreEngine", () => {
  it("passes the core's events to the host, keeping those emitted before attach", () => {
    const engine = new CoreEngine();
    const { emit } = stub(engine);
    const event = { type: "bot.removed", botId: "B1" } as ContractEvent;
    emit({ v: 10, epoch: "e", seq: 1, event } as never);
    const seen: ContractEvent[] = [];
    engine.attach({ event: (e) => seen.push(e), deferTurn: () => false });
    emit({ v: 10, epoch: "e", seq: 2, event } as never);
    expect(seen).toEqual([event, event]);
  });

  it("runs legacy commands through receive and settles them from the core's answers", async () => {
    const engine = new CoreEngine();
    const { received } = stub(engine);
    engine.attach({ event: () => {}, deferTurn: () => false });
    await expect(engine.run({ type: "chat.read", botId: "B1" } as never)).resolves.toEqual({ ran: "chat.read" });
    await expect(engine.run({ type: "files.remove", botId: "B1", id: "f" } as never)).rejects.toMatchObject({ code: "not_found" });
    expect(received).toHaveLength(2);
  });

  it("a started turn gets the done its deferTurn call carried; the host sees the request", async () => {
    const engine = new CoreEngine();
    stub(engine);
    const asked: DeferredTurnRequest[] = [];
    const host: EngineHost = { event: () => {}, deferTurn: (turn) => { asked.push(turn); return false; } };
    engine.attach(host);
    const running = await engine.startTurn({ botId: "B1", turnId: "t-1", replyId: "R", userId: "U", send: { text: "hi" } });
    expect(running.turnId).toBe("t-1");
    await expect(running.done).resolves.toBe("done");
    expect(asked[0]).toMatchObject({ botId: "B1", turnId: "t-1", replyId: "R", userId: "U", origin: "user" });
  });

  it("starts a recorded turn from its words, and removing a bot that is gone resolves", async () => {
    const engine = new CoreEngine();
    stub(engine);
    engine.attach({ event: () => {}, deferTurn: () => false });
    await expect(engine.startTurn({ botId: "B1", turnId: "t-2", replyId: "R", userId: null, words: "go", routine: true })).resolves.toMatchObject({ turnId: "t-2" });
    await expect(engine.removeBot("B1")).resolves.toBeUndefined();
  });
});
