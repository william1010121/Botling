// The process layer says whether a tree really ended (review round 3 #3): a group that survives SIGKILL is reported
// alive, so no caller takes the terminate's answer as a confirmed exit.
import { afterEach, expect, it, vi } from "vitest";

const kill = vi.hoisted(() => ({ survive: false }));
vi.mock("../../src/core/process/kill-tree", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/process/kill-tree")>();
  return { ...real, groupAlive: (pid: number) => kill.survive || real.groupAlive(pid), signalGroup: (pid: number, signal: NodeJS.Signals) => { if (!kill.survive) real.signalGroup(pid, signal); } };
});
const { PosixGroupAdapter } = await import("../../src/core/process/tree");

const children: { kill(): void }[] = [];
afterEach(() => { kill.survive = false; for (const child of children.splice(0)) child.kill(); });

it.skipIf(process.platform === "win32")("a group still alive after SIGKILL is reported alive; one that ended is not", async () => {
  const adapter = new PosixGroupAdapter();
  const stuck = adapter.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { PATH: process.env.PATH } });
  children.push(stuck.child);
  kill.survive = true;
  expect(await stuck.terminate({ graceMs: 0 })).toMatchObject({ forced: true, alive: true });
  kill.survive = false;
  const plain = adapter.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { PATH: process.env.PATH } });
  children.push(plain.child);
  const ended = await plain.terminate({ graceMs: 500 });
  expect(ended.alive).toBeFalsy();
}, 10_000);

it.skipIf(process.platform === "win32")("round 4 #4 a failed terminate is not kept: the next one signals again and sees the group gone", async () => {
  const adapter = new PosixGroupAdapter();
  const stuck = adapter.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { PATH: process.env.PATH } });
  children.push(stuck.child);
  kill.survive = true;
  expect(await stuck.terminate({ graceMs: 0 })).toMatchObject({ alive: true });
  expect(stuck.gone?.()).toBe(false);
  kill.survive = false;
  const again = await stuck.terminate({ graceMs: 500 });
  expect(again.alive).toBeFalsy();
  expect(stuck.gone?.()).toBe(true);
}, 15_000);
