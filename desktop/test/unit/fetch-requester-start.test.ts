// Fetch-receive hardening: botlingd removes the staging folders an unfinished fetch left, when it starts. Two real
// botlingd starts on a temp data folder (the built server, fake engine, no window): the first adds a project folder as a
// bot, then stops; staging folders are planted in that bot's `.bot/incoming/<source>/`; the second start removes them
// and leaves a finished `<fetchId>/` folder alone. (The rules of what may be removed are in fetch-requester.test.ts.)
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MessageOf, Slot } from "../../src/protocol";
import { BotlingdProcess, testRoot } from "../botlingd-harness";

const root = testRoot("fetch-start");
const running: BotlingdProcess[] = [];
afterAll(async () => {
  for (const daemon of running) await daemon.stop("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

describe("botlingd start: leftover fetch staging", () => {
  it("removes `.<uuid>.partial` folders of its bots at start, and keeps a finished fetch folder", async () => {
    const dataDir = join(root, "data");
    const folder = join(root, "project");
    mkdirSync(folder, { recursive: true });

    const first = new BotlingdProcess(dataDir);
    running.push(first);
    await first.ready();
    const client = new (await import("../botlingd-harness")).ScriptClient("script");
    await client.connect(first.socket, first.token);
    await client.sub(client.srv);
    const snap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
    const slot: Slot = { origin: "script", originEpoch: client.originEpoch, target: client.srv, n: 1 };
    client.cmd(slot, { type: "projects.add", folder }, snap.logId);
    const added = await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === slot.n, "projects.add");
    expect(added.outcome.kind).toBe("applied");
    client.close();
    expect(await first.stop()).toBe(0);

    const srv = join(folder, ".bot", "incoming", "build-box-1a2b3c4d");
    const stale = join(srv, `.${randomUUID()}.partial`);
    const finished = join(srv, randomUUID());
    mkdirSync(join(stale, "deep"), { recursive: true });
    writeFileSync(join(stale, "deep", "half.bin"), "half");
    mkdirSync(finished, { recursive: true });
    writeFileSync(join(finished, "kept.txt"), "kept");

    const second = new BotlingdProcess(dataDir);
    running.push(second);
    await second.ready();
    expect(existsSync(stale)).toBe(false);
    expect(readFileSync(join(finished, "kept.txt"), "utf8")).toBe("kept");
    expect(second.log).toMatch(/removed 1 unfinished staging folder/);
    expect(await second.stop()).toBe(0);
  }, 120_000);
});
