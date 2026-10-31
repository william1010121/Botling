// The in-process half of the benchmark: the costs that need no core process, measured on one chat folder
// (argv[2]): reading chat.json, turning every line into what the renderer receives (`messageView`), and the
// cost of one more line (the core rewrites chat.json, and builds one view, per message). Prints JSON.
import { BotStore } from "../../src/core/store/bot-store";
import { messageView } from "../../src/core/bot";
import { performance } from "node:perf_hooks";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const folder = process.argv[2]!, scratch = process.argv[3]!;
const ms = (from: number) => Math.round((performance.now() - from) * 10) / 10;
const result: Record<string, number> = {};

global.gc?.();
const heap0 = process.memoryUsage().heapUsed;
let t = performance.now();
const store = new BotStore(folder);
const { records } = store.loadMessages();
result.loadMs = ms(t);
result.records = records.length;
global.gc?.();
result.heapMB = Math.round((process.memoryUsage().heapUsed - heap0) / 1048576);

t = performance.now();
const views = records.map((record) => messageView(record));
result.viewsMs = ms(t);
t = performance.now();
const json = JSON.stringify(views);
result.viewsStringifyMs = ms(t);
result.viewsMB = Math.round(Buffer.byteLength(json) / 104857.6) / 10;

// One more line: what each message costs the core. A scratch copy, never the source folder.
mkdirSync(scratch, { recursive: true });
copyFileSync(join(folder, "chat.json"), join(scratch, "chat.json"));
const writer = new BotStore(scratch);
const base = records[records.length - 1] ?? { id: "A0000000-0000-4000-8000-000000000001", role: "bot" as const, text: "x", date: 8e8 };
const runs = 15;
let save = 0, view = 0;
for (let i = 0; i < runs; i++) {
  const record = { ...base, id: `C0000000-0000-4000-8000-${String(i).padStart(12, "0")}`, text: "one more line" };
  records.push(record);
  t = performance.now(); messageView(record); view += performance.now() - t;
  t = performance.now(); writer.saveMessages(records); save += performance.now() - t;
}
result.appendSaveMs = Math.round((save / runs) * 10) / 10;
result.appendViewMs = Math.round((view / runs) * 100) / 100;
console.log(JSON.stringify(result));
