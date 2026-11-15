// Botling 3 M4-11/M4-12 follow-up: stdinIo TTY raw-mode echo suppression and restoration for secret prompts.
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import * as pairing from "../../src/server/pairing";

function makeTtyInput(initialRaw = false) {
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode: ReturnType<typeof vi.fn>;
    rawHistory: boolean[];
  };
  stream.isTTY = true;
  stream.isRaw = initialRaw;
  stream.rawHistory = [];
  stream.setRawMode = vi.fn((mode: boolean) => {
    stream.isRaw = mode;
    stream.rawHistory.push(mode);
    return stream;
  });
  return stream;
}

function makeOutput() {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on("data", (chunk) => chunks.push(Buffer.from(chunk).toString("utf8")));
  return {
    stream,
    text: () => chunks.join(""),
    clear: () => { chunks.length = 0; },
  };
}

describe("createStdinIo: TTY raw-mode echo suppression for secrets", () => {
  it("disables echo with setRawMode(true) for secret prompts, handles edits, and restores raw mode afterwards", async () => {
    const createStdinIo = (pairing as Record<string, unknown>).createStdinIo as (
      input: NodeJS.ReadableStream,
      output: NodeJS.WritableStream,
    ) => pairing.CliIo & { close(): void };
    expect(typeof createStdinIo).toBe("function");

    const input = makeTtyInput(false);
    const output = makeOutput();
    const io = createStdinIo(input, output.stream);

    try {
      const p1 = io.ask("Type the recovery code: ", { secret: true });
      expect(input.setRawMode).toHaveBeenCalledWith(true);
      expect(input.isRaw).toBe(true);

      // Type a code with backspace and \r; nothing typed should be echoed to output.
      input.write("ABCD-EX");
      input.write("\x7f");
      input.write("FGH\r");

      const answer1 = await p1;
      expect(answer1).toBe("ABCD-EFGH");
      expect(input.isRaw).toBe(false);
      expect(input.rawHistory).toEqual([true, false]);
      expect(output.text()).toBe("Type the recovery code: \n\n");
      expect(output.text()).not.toContain("ABCD");

      // A subsequent non-secret prompt on the same TTY does not use raw mode and receives its own line cleanly.
      output.clear();
      const p2 = io.ask("Type lost or keep: ");
      expect(input.isRaw).toBe(false);
      expect(input.rawHistory).toEqual([true, false]);
      input.write("lost\n");
      expect(await p2).toBe("lost");

      // Ctrl-U clears the current line, and another secret prompt restores prior isRaw state.
      const p3 = io.ask("Confirm code: ", { secret: true });
      expect(input.isRaw).toBe(true);
      input.write("WRONG");
      input.write("\x15");
      input.write("RIGHT\r\n");
      expect(await p3).toBe("RIGHT");
      expect(input.isRaw).toBe(false);
      expect(output.text()).not.toContain("WRONG");
      expect(output.text()).not.toContain("RIGHT");
    } finally {
      io.close();
    }
  });

  it("restores raw mode and returns null on Ctrl-D / Ctrl-C / close during a secret prompt", async () => {
    const createStdinIo = (pairing as Record<string, unknown>).createStdinIo as (
      input: NodeJS.ReadableStream,
      output: NodeJS.WritableStream,
    ) => pairing.CliIo & { close(): void };
    expect(typeof createStdinIo).toBe("function");

    const input = makeTtyInput(false);
    const output = makeOutput();
    const io = createStdinIo(input, output.stream);

    try {
      const pCtrlD = io.ask("Secret 1: ", { secret: true });
      expect(input.isRaw).toBe(true);
      input.write("\x04");
      expect(await pCtrlD).toBeNull();
      expect(input.isRaw).toBe(false);

      const pCtrlC = io.ask("Secret 2: ", { secret: true });
      expect(input.isRaw).toBe(true);
      input.write("partial\x03");
      expect(await pCtrlC).toBeNull();
      expect(input.isRaw).toBe(false);
      expect(output.text()).not.toContain("partial");
    } finally {
      io.close();
    }
  });

  it("keeps non-TTY piped input behavior unchanged for secret and non-secret prompts", async () => {
    const createStdinIo = (pairing as Record<string, unknown>).createStdinIo as (
      input: NodeJS.ReadableStream,
      output: NodeJS.WritableStream,
    ) => pairing.CliIo & { close(): void };
    expect(typeof createStdinIo).toBe("function");

    const input = new PassThrough();
    const output = makeOutput();
    const io = createStdinIo(input, output.stream);

    try {
      input.write("CODE-1234\nlost\n");
      input.end();
      expect(await io.ask("Code: ", { secret: true })).toBe("CODE-1234");
      expect(await io.ask("Choice: ")).toBe("lost");
      expect(await io.ask("EOF: ", { secret: true })).toBeNull();
    } finally {
      io.close();
    }
  });
});
