// A bot that redraws the same picture file and names it in each reply (DaFaJi's training plot at
// .bot/artifacts/n46_wide_training.png): every reply shows the picture as it was when it was posted,
// under a URL of its own, never the copy the page loaded for an earlier reply.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { CoreHarness, MAIN } from "../core-harness";
import { tempDir, until } from "../helpers";
import { localMediaSource } from "../../src/contract/attachment-url";
import { renderMarkdown, setMediaSource } from "../../../Web/src/markdown";
import { keepLineMedia, lineMediaCopy, localMediaPaths } from "../../src/core/chat-media";

it("serves each reply its own copy of a picture rewritten at the same path", async () => {
  const dir = tempDir("chat-media-snapshot");
  const plot = join(dir, "n46_wide_training.png");
  const url = pathToFileURL(plot).href;
  const cli = join(dir, "plot-cli.mjs");
  writeFileSync(cli, `import {createInterface} from 'node:readline';
const out = x => process.stdout.write(JSON.stringify(x)+'\\n');
out({type:'system',subtype:'init',session_id:'plot-session',tools:[],model:'fake'});
createInterface({input:process.stdin}).on('line', line => {
  const x=JSON.parse(line);
  if(x.type==='control_request' && x.request?.subtype==='initialize') out({type:'control_response',response:{subtype:'success',request_id:x.request_id,response:{}}});
  if(x.type!=='user')return;
  out({type:'assistant',message:{content:[{type:'text',text:${JSON.stringify(`New plot: ![plot](${url})`)}}]}});
  out({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(`New plot: ![plot](${url})`)},session_id:'plot-session',total_cost_usd:0});
});`);
  const core = new CoreHarness(dir, { BOTLING_FAKE_CLI: cli, BOTLING_UPDATE_PENDING: "", BOTLING_IMPORT_FROM: "" });
  try {
    writeFileSync(plot, "iteration 217");
    await core.call({ type: "chat.send", botId: MAIN, text: "plot it" });
    await until(() => core.of("turn.finished").length === 1);
    writeFileSync(plot, "iteration 231");
    await core.call({ type: "chat.send", botId: MAIN, text: "plot it again" });
    await until(() => core.of("turn.finished").length === 2);
    const replies = (await core.chat()).messages.filter((message: any) => message.role === "bot" && message.text.includes(url));
    expect(replies).toHaveLength(2);
    const [first, second] = replies.map((message: any) => message.id as string);
    const served = async (line?: string) => {
      const answer = await core.call({ type: "attachment.file", botId: MAIN, ref: url, ...(line ? { line } : {}) }) as { path: string };
      return readFileSync(answer.path, "utf8");
    };
    expect(await served(second)).toBe("iteration 231");
    expect(await served(first)).toBe("iteration 217");
    // Without a line (older pages), the file as it is now.
    expect(await served()).toBe("iteration 231");
    // The chat frame asks for each reply's picture by a URL of its own.
    expect(localMediaSource(MAIN, url, first)).not.toBe(localMediaSource(MAIN, url, second));
    // A path no line names stays refused, with or without a line.
    await expect(core.call({ type: "attachment.file", botId: MAIN, ref: pathToFileURL(join(dir, "other.png")).href, line: first! })).rejects.toThrow("not_found");
  } finally { await core.kill("SIGKILL"); }
});

it("renders a reply's pictures with its line, so two replies naming one path load different URLs", () => {
  setMediaSource((url, line) => localMediaSource("B", url, line));
  try {
    const text = "![plot](file:///Users/me/p/.bot/artifacts/n46_wide_training.png)";
    const src = (html: string) => /<img[^>]* src="([^"]+)"/.exec(html)?.[1];
    const a = src(renderMarkdown(text, "LINE-A")), b = src(renderMarkdown(text, "LINE-B"));
    expect(a).toMatch(/^botling-chat:\/\/chat\/attachment\/B\/.+\/n46_wide_training\.png\?line=LINE-A$/);
    expect(b).not.toBe(a);
    // The bot's own URL stays on the element (open / reveal use it).
    expect(renderMarkdown(text, "LINE-A")).toContain('data-url="file:///Users/me/p/.bot/artifacts/n46_wide_training.png"');
  } finally { setMediaSource((url) => url); }
});

it("finds the local pictures a line shows and keeps a copy of each", () => {
  const dir = tempDir("chat-media-keep");
  const picture = join(dir, "圖 a.png");
  writeFileSync(picture, "v1");
  const text = `![a](${pathToFileURL(picture).href}) and ![b](/nowhere/b.jpg) [notes](file:///x/notes.txt) https://e.org/c.png`;
  expect(localMediaPaths(text)).toEqual([picture, "/nowhere/b.jpg"]);
  keepLineMedia(join(dir, "store"), "LINE-1", text);
  writeFileSync(picture, "v2");
  expect(readFileSync(lineMediaCopy(join(dir, "store"), "LINE-1", picture)!, "utf8")).toBe("v1");
  expect(lineMediaCopy(join(dir, "store"), "LINE-1", "/nowhere/b.jpg")).toBeNull();
  expect(lineMediaCopy(join(dir, "store"), "../escape", picture)).toBeNull();
});
