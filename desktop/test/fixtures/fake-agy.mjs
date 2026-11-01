// A fake Antigravity ACP server for offline tests: it replays a recorded worker stream
// (test/fixtures/worker-streams/agy/<scenario>.jsonl, the format of test/worker-streams/replay.ts) to whatever speaks
// ACP on its stdin: streamed agent_message_chunk updates, tool calls that fail, approvals, the prompt's stop reason.
// Each line the client writes must be the recording's next "in" line (a request or notification by its method, an
// answer to the server's own request by its id); the recorded "out" lines after it then play, a macrotask apart, up to
// the next "in" line, with response ids mapped to the client's own. A recorded exit with nothing left to wait for
// ends it the same way (its code or signal).
//   node fake-agy.mjs <recording.jsonl>   (or FAKE_AGY_RECORDING=<file>); FAKE_AGY_INPUT=<file> appends what it read.
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';

const file = process.argv[2] ?? process.env.FAKE_AGY_RECORDING;
if (!file) { process.stderr.write('usage: fake-agy.mjs <recording.jsonl>\n'); process.exit(2); }
const [, ...lines] = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
/** The recorded request ids → the client's. */
const ids = new Map();
let at = 0;

/** Plays the recorded lines from `at` up to the next one the client has to write. */
async function play() {
  while (at < lines.length && lines[at].d !== 'in') {
    const { d, l } = lines[at++];
    if (d === 'out') {
      const message = JSON.parse(l);
      if (!message.method && message.id !== undefined && ids.has(message.id)) message.id = ids.get(message.id);
      process.stdout.write(JSON.stringify(message) + '\n');
      await new Promise((resolve) => setImmediate(resolve));
    } else if (d === 'exit') {
      const { code, signal } = JSON.parse(l);
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 0);
    }
  }
}

await play();
for await (const raw of createInterface({ input: process.stdin })) {
  if (!raw.trim()) continue;
  if (process.env.FAKE_AGY_INPUT) appendFileSync(process.env.FAKE_AGY_INPUT, raw + '\n');
  const message = JSON.parse(raw), next = lines[at], recorded = next?.d === 'in' ? JSON.parse(next.l) : null;
  if (!recorded || (recorded.method ? recorded.method !== message.method : recorded.id !== message.id)) {
    process.stderr.write(`fake-agy: unexpected client line ${raw.slice(0, 200)}\n`);
    process.exit(3);
  }
  at++;
  if (recorded.method && recorded.id !== undefined) ids.set(recorded.id, message.id);
  await play();
}
