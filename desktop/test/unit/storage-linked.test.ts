// A bot's Storage also lists the files it handed over in its replies (file: links to local files outside its artifacts
// folder): references to where they are, newest reply first, once per path, with the reply's time.
import { afterEach, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CoreHarness, MAIN } from "../core-harness";
import { swiftLine, tempDir } from "../helpers";
import { linkedFiles, replyFilePaths } from "../../src/core/storage";

const running: CoreHarness[] = [];
afterEach(async () => { for (const c of running.splice(0)) await c.kill(); });
const SWIFT = Date.UTC(2001, 0, 1);
const at = (ms: number) => (ms - SWIFT) / 1000;

it("lists a Markdown file a bot reply links outside its artifacts folder, as a reference with the reply's time", async () => {
  const data = tempDir("storage-linked");
  const docs = join(data, "docs", "05-AI分析");
  mkdirSync(docs, { recursive: true });
  const md = join(docs, "研究 總整理.md");
  writeFileSync(md, "# notes");
  mkdirSync(join(data, "main"));
  writeFileSync(join(data, "main/chat.json"), JSON.stringify([
    swiftLine({ id: randomUUID(), role: "bot", text: `整理好了：[總整理](${pathToFileURL(md).href})`, date: at(1_760_000_000_000) }),
  ]));
  const c = new CoreHarness(data); running.push(c);
  const { items } = await c.call({ type: "storage.list", botId: MAIN });
  const row = items.find((item: { path: string }) => item.path === md);
  expect(row).toMatchObject({ source: "bot", name: "研究 總整理.md", kind: "doc", missing: false, size: 7, added: 1_760_000_000_000 });
  // The core first: it may still be writing in the folder.
  await c.kill(); running.splice(running.indexOf(c), 1);
  rmSync(data, { recursive: true, force: true });
});

it("finds file links in reply text: markdown links, images, bare URLs and absolute paths; never http(s) or relative", () => {
  const text = [
    "[a](file:///x/a%20b.md) ![pic](file:///x/p.png)",
    "see file:///x/bare.pdf. and [abs](/x/abs.csv) [web](https://e.org/f.pdf) [rel](notes.md)",
    "[again](file:///x/a%20b.md#top) [q](file:///x/q.txt?raw=1)",
  ].join("\n");
  expect(replyFilePaths(text)).toEqual(["/x/a b.md", "/x/p.png", "/x/bare.pdf", "/x/abs.csv", "/x/q.txt"]);
});

it("keeps bot replies only (not yours, not a guest's), newest reply first, once per path, skipping folders and files never there", () => {
  const dir = tempDir("storage-linked-unit");
  const one = join(dir, "one.md"), two = join(dir, "two.pdf"), sub = join(dir, "sub");
  writeFileSync(one, "1"); writeFileSync(two, "2"); mkdirSync(sub);
  const url = (path: string) => pathToFileURL(path).href;
  const records = [
    { id: "1", role: "bot", text: `[one](${url(one)})`, date: at(1000) },
    { id: "2", role: "user", text: `[two](${url(two)})`, date: at(2000) },
    { id: "3", role: "bot", sourceID: "GUEST", text: `[two](${url(two)})`, date: at(3000) },
    { id: "4", role: "bot", text: `[folder](${url(sub)}) [gone](${url(join(dir, "never.md"))}) [two](${url(two)}) [one](${url(one)})`, date: at(4000) },
  ];
  expect(linkedFiles(records)).toEqual([{ path: two, at: 4000 }, { path: one, at: 4000 }]);
  // Indexed once: a file deleted afterwards stays listed (as missing, like a dragged-in file).
  rmSync(one);
  expect(linkedFiles(records).map((file) => file.path)).toEqual([two, one]);
  rmSync(dir, { recursive: true, force: true });
});
