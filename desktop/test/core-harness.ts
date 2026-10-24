// Drives the built core process over its stdio transport, the way main drives it over parentPort.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { desktop, fakeCli, until } from "./helpers";
import type { EventEnvelope, ResponseEnvelope, Outbound } from "../src/contract";

const coreScript = join(desktop, "out", "core", "main.cjs");

/** The main bot's id (the Swift app's `Workspace.mainBotID`). */
export const MAIN = "6A0B0000-0000-4000-8000-000000000002";

export class CoreHarness {
  child: ChildProcessWithoutNullStreams;
  events: (EventEnvelope & { at: number })[] = [];
  responses = new Map<string, ResponseEnvelope>();
  stderr = "";
  private counter = 0;

  constructor(readonly dataDir: string, env: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [coreScript], {
      env: { ...process.env, BOTLING_DATA_DIR: dataDir, BOTLING_AGENT: "fake", BOTLING_FAKE_CLI: fakeCli, ...env },
      stdio: "pipe",
    });
    this.child.stderr.on("data", (chunk) => (this.stderr += chunk));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as Outbound;
      if ("event" in message) this.events.push({ ...message, at: Date.now() });
      else this.responses.set(message.id, message);
    });
  }

  post(value: unknown) {
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }

  send(cmd: unknown, id = `r${++this.counter}`) {
    this.post({ v: 2, id, cmd });
    return id;
  }

  async call(cmd: unknown): Promise<any> {
    const id = this.send(cmd);
    const response = await until(() => this.responses.get(id), { what: `response to ${JSON.stringify(cmd)}` });
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
    return response.result;
  }

  of(type: string) {
    return this.events.filter((e) => e.event.type === type);
  }

  /** The main bot's chat, as a snapshot shows it. */
  async chat(botId = MAIN): Promise<any> {
    return (await this.call({ type: "chat.snapshot", botId })).chat;
  }

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.child.kill(signal);
    return new Promise((resolve) => this.child.once("exit", resolve));
  }
}

