// A pinned card keeps the Command its component had when pinned; an updated component must reach it (what the core's
// pin-command-follows-component.test.ts pinned down, now the plugin's rule).
import { describe, expect, it } from "vitest";
import { basePin, BOT, FakeBotling, FOLDER } from "./pinbook";

const OLD = "timeout 25 ssh host nvidia-smi";
const NEW = "export PATH=/opt/homebrew/bin:$PATH; ssh host nvidia-smi";

function fixture(pin: Record<string, unknown>, shown: { name: string; command: string | null }[] = []) {
  const f = new FakeBotling();
  f.entries["gpu-status"] = { command: OLD, detail: null, every: null, sizes: ["4x2"] };
  f.stored.set(BOT, [basePin({ command: OLD, ...pin })]);
  f.shownCards = shown.map((card, index) => ({ messageId: "m", index, name: card.name, command: card.command, shownCommand: card.command, data: "null", author: null }));
  const setCommand = (command: string) => { f.entries["gpu-status"]!.command = command; };
  return { f, book: f.book(), setCommand };
}

describe("a pin follows its component's Command", () => {
  it("a legacy pin takes the component's updated Command, and ↻ runs the new one once allowed", async () => {
    const { f, book, setCommand } = fixture({});
    setCommand(NEW);
    const view = (await book.view(BOT)).pins[0]!;
    expect(view.display.command).toBe(NEW);
    expect((f.stored.get(BOT)![0] as { command: string }).command).toBe(NEW);
    // The old approval does not carry over to the new line.
    f.approved.add(OLD);
    expect(await book.command(BOT, "P1", { command: OLD, force: true })).toEqual({ accepted: false });
    f.approved.add(NEW);
    expect(await book.command(BOT, "P1", { command: NEW, force: true })).toEqual({ accepted: true });
    expect(f.runs).toEqual([{ card: "pin/P1", command: NEW, force: true }]);
  });

  it("a pin made from a tag's own command=\"…\" keeps it", async () => {
    const { book, setCommand } = fixture({ followsComponent: false });
    setCommand(NEW);
    expect((await book.view(BOT)).pins[0]!.display.command).toBe(OLD);
  });

  it("a legacy pin whose command a shown card carried explicitly keeps it", async () => {
    const { book, setCommand } = fixture({}, [{ name: "gpu-status", command: OLD }]);
    setCommand(NEW);
    expect((await book.view(BOT)).pins[0]!.display.command).toBe(OLD);
  });

  it("a pin that follows takes the new command whatever a shown card carried once it is marked as following", async () => {
    const { book, setCommand } = fixture({ followsComponent: true }, [{ name: "gpu-status", command: OLD }]);
    setCommand(NEW);
    expect((await book.view(BOT)).pins[0]!.display.command).toBe(NEW);
  });

  it("asks what the sheet shows (command, folder, Detail command, the component's name) until both are allowed", async () => {
    const { f, book } = fixture({});
    f.entries["gpu-status"]!.detail = "ssh host nvidia-smi -q {gpu}";
    f.approved.add(OLD);
    expect(await book.command(BOT, "P1", { command: OLD, folder: FOLDER })).toEqual({
      accepted: false, needsApproval: { command: OLD, folder: FOLDER, detail: "ssh host nvidia-smi -q {gpu}", card: "gpu-status" },
    });
    f.approved.add("Detail command: ssh host nvidia-smi -q {gpu}");
    expect(await book.command(BOT, "P1", { command: OLD, folder: FOLDER })).toEqual({ accepted: true });
    // What it was shown is what it must still be: another command or folder is not accepted.
    expect(await book.command(BOT, "P1", { command: "rm -rf /", folder: FOLDER })).toEqual({ accepted: false });
    expect(await book.command(BOT, "P1", { command: OLD, folder: "/elsewhere" })).toEqual({ accepted: false });
  });
});
