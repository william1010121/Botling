// Child process of test/unit/server-content-crash.test.ts (bundled by the test; no window). It opens server.db in
// <dataDir>, then posts finished lines until it is killed: line i names a video, a picture and a PDF in <mediaDir>,
// rewritten before each line (a bot that renders again at once), so a line's pin either keeps its own version or, when
// the next rewrite came first, is `changed`. The line's entry, its content rows, content_refs and content_names commit
// together; pinning and hashing (worker thread) then run after the commit and record content.ready. It writes "ack <seq>" once a line's entry committed and "hashed <seq>" once its content.ready entries
// did (synchronous writes, so the parent hears them no later than they happened).
import { writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { StreamId } from "../../src/protocol";
import { ContentService, type PinKind } from "../../src/server/content";
import { ensureStream } from "../../src/server/log";
import { openServerStore } from "../../src/server/store";

const [dataDir, mediaDir, mode] = process.argv.slice(2);
const STREAM = "bot:crash" as StreamId;
const say = (text: string) => writeSync(1, `${text}\n`);

async function main() {
  const store = await openServerStore(dataDir!);
  await store.submit((db) => ensureStream(db, STREAM));
  const force = mode === "auto" ? undefined : (mode as PinKind);
  const service = new ContentService({ store, dataDir: dataDir!, serverId: store.meta("serverId")!, pin: { force } });
  await service.recover();
  say("ready");
  for (let i = 1; ; i++) {
    const video = join(mediaDir!, "render.mp4");
    const picture = join(mediaDir!, "plot.png");
    const pdf = join(mediaDir!, "report.pdf");
    writeFileSync(video, randomBytes(1024 * 1024 + (i % 5) * 300_000));
    writeFileSync(picture, randomBytes(30_000 + i));
    writeFileSync(pdf, Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(150_000)]));
    const id = `line-${i}`;
    const text = `![v](${pathToFileURL(video).href}) ![p](${picture}) [r](${pathToFileURL(pdf).href})`;
    const message = { id, role: "bot", text, time: "2026-11-14T00:00:00.000Z", state: "done" };
    const { entries, ready } = await service.appendLine(STREAM, "crash", { id, text }, [{ kind: "message.added", body: { botId: "crash", message } }]);
    const seq = entries[0]!.seq;
    say(`ack ${seq}`);
    void ready.then(() => say(`hashed ${seq}`), () => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
