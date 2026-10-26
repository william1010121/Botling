// A headless Claude stream fixture: the test supplies the exact frames for each turn.
import { createInterface } from "node:readline";
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type !== "user") continue;
  out({ type: "system", subtype: "init", session_id: message.session_id });
  const text = JSON.stringify(message.message.content);
  const encoded = [...text.matchAll(/SCHEDULE_FRAMES:([A-Za-z0-9+/=]+)/g)].map((match) => match[1]).at(-1);
  if (encoded) for (const frame of JSON.parse(Buffer.from(encoded, "base64").toString())) out(frame);
  out({ type: "result", subtype: "success", result: "Schedule checked." });
}
