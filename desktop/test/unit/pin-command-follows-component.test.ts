// A pinned card keeps the Command its component had when pinned; an updated component must reach it.
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { Bot } from "../../src/core/bot";
import { ComponentsContext } from "../../src/core/components/service";
import { ProcessLedger } from "../../src/core/process/ledger";
import { mainProfile } from "../../src/core/store/workspace";
import { ComponentCommands } from "../../src/core/components/commands";

const OLD = "timeout 25 ssh host nvidia-smi";
const NEW = "export PATH=/opt/homebrew/bin:$PATH; ssh host nvidia-smi";
const roots: string[] = [], bots: Bot[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.shutdown({ tidy: false });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(pin: Record<string, unknown>, records: unknown[] = []) {
  const root = tempDir("pin-follow"); roots.push(root);
  const lib = join(root, "lib"); mkdirSync(join(lib, "gpu-status"), { recursive: true });
  writeFileSync(join(lib, "gpu-status", "template.html"), "<div></div>");
  const setCommand = (command: string) => writeFileSync(join(lib, "gpu-status", "about.md"), `GPU board.\nCommand: ${command}\n`);
  setCommand(OLD);
  const calls: string[] = [];
  const commands = new ComponentCommands(join(root, "approved.json"), async (command) => { calls.push(command); return { data: '"ok"', ranAt: Date.now() }; });
  const components = new ComponentsContext(root, () => [lib], commands);
  const profile = mainProfile(root);
  const bot = new Bot({ profile, engine: "claude", deferStartup: true, welcome: false, components,
    headConfig() { throw Error("no CLI"); }, prompts() { throw Error("no turn"); },
    ledger: new ProcessLedger(join(root, "ledger.json")), emit: () => {}, log: vi.fn(),
    approvalTimeoutMs: 100, idleMs: 100, interruptGraceMs: 100 });
  bots.push(bot);
  (bot as any).pins = [{ id: "P1", name: "gpu-status", data: "null", refresh: "manual", minutes: 15, size: "4x2", makingLive: false, command: OLD, ...pin }];
  (bot as any).records = records;
  return { bot, setCommand, calls, commands, profile };
}

it("a legacy pin takes the component's updated Command, and ↻ runs the new one once allowed", () => {
  const f = fixture({});
  f.setCommand(NEW);
  const view = f.bot.pinsView().pins[0]!;
  expect(view.display.command).toBe(NEW);
  expect((f.bot as any).pins[0].command).toBe(NEW);
  // The old approval does not carry over to the new line.
  f.commands.approve(OLD, f.profile.folder);
  expect(f.bot.pinCommand("P1", { command: OLD, force: true })).toEqual({ accepted: false });
  f.commands.approve(NEW, f.profile.folder);
  expect(f.bot.pinCommand("P1", { command: NEW, force: true })).toEqual({ accepted: true });
});

it("a pin made from a tag's own command=\"…\" keeps it", () => {
  const f = fixture({ followsComponent: false });
  f.setCommand(NEW);
  expect(f.bot.pinsView().pins[0]!.display.command).toBe(OLD);
});

it("a legacy pin whose command a shown card carried explicitly keeps it", () => {
  const f = fixture({}, [{ id: "m", role: "bot", displays: [{ name: "gpu-status", data: "null", command: OLD }] }]);
  f.setCommand(NEW);
  expect(f.bot.pinsView().pins[0]!.display.command).toBe(OLD);
});
