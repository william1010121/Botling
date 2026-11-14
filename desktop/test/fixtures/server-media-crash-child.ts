// Child process of test/unit/server-media.test.ts (bundled by the test; no window). It opens server.db in <dataDir>,
// recovers the content index and the media jobs, posts one finished line naming <video> (unless the line is there
// already) and lets the media job run. It writes "step <kind:variant>" as the job reaches each step and "idle" when the
// queue is empty; the parent SIGKILLs it at a chosen step.
import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { StreamId } from "../../src/protocol";
import { ContentService } from "../../src/server/content";
import { ensureStream } from "../../src/server/log";
import { MediaJobs } from "../../src/server/media";
import { openServerStore } from "../../src/server/store";

const [dataDir, video] = process.argv.slice(2);
const STREAM = "bot:media" as StreamId;
const say = (text: string) => writeSync(1, `${text}\n`);

async function main() {
  const store = await openServerStore(dataDir!);
  await store.submit((db) => ensureStream(db, STREAM));
  const content = new ContentService({ store, dataDir: dataDir!, serverId: store.meta("serverId")! });
  const media = new MediaJobs({ store, dataDir: dataDir!, onStep: (_id, step) => say(`step ${step}`) });
  content.attachMedia(media);
  await content.recover();
  const started = await media.start();
  say(`started ${JSON.stringify(started)}`);
  const reader = store.openReader();
  const posted = reader.prepare("SELECT 1 FROM entries WHERE stream = ? AND kind = 'message.added'").get(STREAM);
  reader.close();
  if (!posted) {
    const text = `![clip](${pathToFileURL(video!).href})`;
    const message = { id: "line-1", role: "bot", text, time: "2026-11-15T00:00:00.000Z", state: "done" };
    const { ready } = await content.appendLine(STREAM, "media", { id: "line-1", text }, [{ kind: "message.added", body: { botId: "media", message } }]);
    await ready;
  }
  await media.idle();
  say("idle");
  await media.close();
  await content.close();
  await store.close();
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
