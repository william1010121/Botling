// Drives the built core process over its stdio transport, the way main drives it over parentPort.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { desktop, fakeCli, fakeCodex, until } from "./helpers";
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
  private failure = "";
  private closed: Promise<void>;

  constructor(readonly dataDir: string, env: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [coreScript], {
      env: { ...process.env, BOTLING_DATA_DIR: dataDir, BOTLING_AGENT: "fake", BOTLING_FAKE_CLI: fakeCli, BOTLING_FAKE_CODEX: fakeCodex, ...env },
      stdio: "pipe",
    });
    this.closed = new Promise(resolve => this.child.once("close",()=>resolve()));
    this.child.on("error",error=>{this.failure=`spawn: ${error.message}`;});
    this.child.on("exit",(code,signal)=>{this.failure=`core exited: code=${code}, signal=${signal}`;});
    this.child.stdin.on("error",error=>{this.failure ||= `stdin: ${error.message}`;});
    this.child.stderr.on("data", (chunk) => {this.stderr=(this.stderr+chunk).slice(-65536);});
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message:Outbound;
      try{message=JSON.parse(line) as Outbound;}catch{this.failure=`invalid core output: ${line.slice(0,1000)}`;return;}
      if ("event" in message) this.events.push({ ...message, at: Date.now() });
      else this.responses.set(message.id, message);
    });
  }

  post(value: unknown) {
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }

  send(cmd: unknown, id = `r${++this.counter}`) {
    this.post({ v: 10, id, cmd });
    return id;
  }

  private diagnostic(cmd:unknown,cause:string):Error {
    return new Error(`${cause}\ncommand: ${JSON.stringify(cmd)}\npid: ${this.child.pid}; data: ${this.dataDir}\nrecent events: ${this.events.slice(-8).map(e=>e.event.type).join(', ')}\nstderr (last 64 KiB):\n${this.stderr}`);
  }

  async call(cmd: unknown,{timeout=10_000}={}): Promise<any> {
    if(this.failure)throw this.diagnostic(cmd,this.failure);
    const id = this.send(cmd);
    const response = await until(() => {
      const response=this.responses.get(id);if(response)return response;
      if(this.failure)throw this.diagnostic(cmd,this.failure);
      return null;
    }, {timeout,what: `response to ${JSON.stringify(cmd)}`}).catch(error=>{throw this.diagnostic(cmd,String(error.message||error));});
    if (!response.ok) throw this.diagnostic(cmd,`${response.error.code}: ${response.error.message}`);
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
    if(this.child.exitCode===null&&this.child.signalCode===null)this.child.kill(signal);
    // Registered at spawn, so teardown also joins an already exited/failed child and its streams.
    return this.closed;
  }
}

