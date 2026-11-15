// Stdin/stdout line input for the CLI (main.ts): suppresses terminal echo via raw mode when reading recovery codes
// on a TTY, restores the prior mode when done or cancelled, and leaves piped/non-TTY stdin unchanged.
import { createInterface } from "node:readline";
import type { CliIo } from "./cli";

export interface TtyReadable extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

/** Line input for CLI prompts (returns null on EOF or Ctrl-C/Ctrl-D). */
export function createStdinIo(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): CliIo & { close(): void } {
  const out = (line: string) => {
    output.write(`${line}\n`);
  };
  const tty = input as TtyReadable;
  const isTty = Boolean(tty.isTTY) && typeof tty.setRawMode === "function";

  if (!isTty) {
    const lines: string[] = [];
    const waiters: Array<(line: string | null) => void> = [];
    let ended = false;
    const reader = createInterface({ input, terminal: false });
    reader.on("line", (line) => {
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    });
    reader.on("close", () => {
      ended = true;
      for (const waiter of waiters.splice(0)) waiter(null);
    });
    return {
      out,
      ask: (prompt) => {
        output.write(prompt.endsWith("\n") ? prompt : `${prompt}\n`);
        if (lines.length) return Promise.resolve(lines.shift()!);
        if (ended) return Promise.resolve(null);
        return new Promise((resolve) => waiters.push(resolve));
      },
      close: () => reader.close(),
    };
  }

  let closed = false;
  let remainder = "";
  let skipLeadingLf = false;
  let activeCancel: (() => void) | null = null;

  const readSecretTtyLine = (): Promise<string | null> => {
    const wasRaw = Boolean(tty.isRaw);
    tty.setRawMode!(true);
    return new Promise((resolve) => {
      const chars: string[] = [];
      let done = false;

      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        activeCancel = null;
        input.removeListener("data", onData);
        input.removeListener("end", onEnd);
        input.removeListener("close", onEnd);
        input.pause();
        tty.setRawMode!(wasRaw);
        resolve(value);
      };

      const processText = (text: string) => {
        for (let i = 0; i < text.length; i++) {
          const ch = text[i]!;
          if (skipLeadingLf) {
            skipLeadingLf = false;
            if (ch === "\n") continue;
          }
          if (ch === "\r" || ch === "\n") {
            if (ch === "\r") {
              if (text[i + 1] === "\n") i++;
              else if (i === text.length - 1) skipLeadingLf = true;
            }
            remainder = text.slice(i + 1);
            output.write("\n");
            finish(chars.join(""));
            return;
          }
          if (ch === "\u0003") {
            remainder = "";
            output.write("\n");
            finish(null);
            return;
          }
          if (ch === "\u0004") {
            remainder = "";
            output.write("\n");
            finish(chars.length ? chars.join("") : null);
            return;
          }
          if (ch === "\u007f" || ch === "\u0008") {
            chars.pop();
            continue;
          }
          if (ch === "\u0015") {
            chars.length = 0;
            continue;
          }
          if (ch >= " " && ch !== "\u007f") {
            chars.push(ch);
          }
        }
      };

      const onData = (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        processText(text);
      };

      const onEnd = () => {
        finish(chars.length ? chars.join("") : null);
      };

      activeCancel = () => finish(null);

      if (remainder) {
        const initial = remainder;
        remainder = "";
        processText(initial);
        if (done) return;
      }

      input.on("data", onData);
      input.on("end", onEnd);
      input.on("close", onEnd);
      input.resume();
    });
  };

  const readCookedTtyLine = (): Promise<string | null> =>
    new Promise((resolve) => {
      let buf = "";
      let done = false;

      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        activeCancel = null;
        input.removeListener("data", onData);
        input.removeListener("end", onEnd);
        input.removeListener("close", onEnd);
        input.pause();
        resolve(value);
      };

      const processText = (text: string) => {
        for (let i = 0; i < text.length; i++) {
          const ch = text[i]!;
          if (skipLeadingLf) {
            skipLeadingLf = false;
            if (ch === "\n") continue;
          }
          if (ch === "\r" || ch === "\n") {
            if (ch === "\r") {
              if (text[i + 1] === "\n") i++;
              else if (i === text.length - 1) skipLeadingLf = true;
            }
            remainder = text.slice(i + 1);
            finish(buf);
            return;
          }
          buf += ch;
        }
      };

      const onData = (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        processText(text);
      };

      const onEnd = () => {
        finish(buf.length ? buf : null);
      };

      activeCancel = () => finish(null);

      if (remainder) {
        const initial = remainder;
        remainder = "";
        processText(initial);
        if (done) return;
      }

      input.on("data", onData);
      input.on("end", onEnd);
      input.on("close", onEnd);
      input.resume();
    });

  return {
    out,
    ask: (prompt, options) => {
      output.write(prompt.endsWith("\n") ? prompt : `${prompt}\n`);
      if (closed) return Promise.resolve(null);
      return options?.secret ? readSecretTtyLine() : readCookedTtyLine();
    },
    close: () => {
      closed = true;
      activeCancel?.();
    },
  };
}
