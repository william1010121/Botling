// Pictures and videos a reply shows by their local path (`![caption](file:///…/x.png)`, or a bare
// absolute path), as 1.x draws them inline: the chat frame (botling-chat://chat) cannot load file://,
// so the chat origin serves them, but only image/video files this bot's chat names.
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { swiftLine, tempDir } from "../helpers";
import { chatFrame, launch, MAIN } from "./launch";

/** A 4×4 red PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC", "base64");

test("a reply's local pictures and videos show inline; files the chat does not name are not served", async () => {
  const project = tempDir("e2e-local-media");
  const artifacts = join(project, ".bot", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const board = join(artifacts, "main-whiteboard.png");
  const bare = join(project, "bare.png");
  const spaced = join(project, "圖 one.png");
  const clip = join(project, "clip.mp4");
  const notes = join(project, "notes.txt");
  const unnamed = join(project, "unnamed.png");
  for (const file of [board, bare, spaced, unnamed]) writeFileSync(file, PNG);
  writeFileSync(clip, Buffer.alloc(4096, 7));
  writeFileSync(notes, "secret notes");
  const text = [
    `![白板](${pathToFileURL(board).href})`,
    `![bare](${bare})`,
    `![spaced](${pathToFileURL(spaced).href})`,
    `![clip](${pathToFileURL(clip).href})`,
    `![notes](${pathToFileURL(notes).href})`,
  ].join("\n\n");
  const { app, page, chat } = await launch({ chat: [swiftLine({ id: "00000000-0000-4000-8000-0000000000A1", role: "bot", text, state: "done" })] });
  try {
    const reply = chat.locator(".row.bot[data-id]").last();
    for (const label of ["白板", "bare", "spaced"]) {
      const image = reply.locator(`img.media[alt="${label}"]`);
      await expect(image).toHaveJSProperty("complete", true);
      await expect(image).toHaveJSProperty("naturalWidth", 4);
    }
    // The picture keeps its file:// URL for "open"/"show in Finder"; only its source is the chat origin's.
    await expect(reply.locator('img.media[alt="白板"]')).toHaveAttribute("data-url", pathToFileURL(board).href);
    // The lightbox shows the picture too.
    await reply.locator('img.media[alt="白板"]').click();
    await expect(chat.locator(".lightbox-image")).toHaveJSProperty("naturalWidth", 4);
    await chat.locator(".lightbox-close").click();
    const video = reply.locator("video.media");
    await expect(video).toHaveAttribute("src", /^botling-chat:\/\/chat\//);
    const src = await video.getAttribute("src");

    const frame = await chatFrame(page);
    expect(frame.url()).toBe("botling-chat://chat/chat.html");
    const encode = (value: string) => Buffer.from(value).toString("base64url");
    const at = (value: string) => `botling-chat://chat/attachment/${MAIN}/${encode(value)}`;
    const served = await app.evaluate(async ({ net }, { urls, video }) => {
      const out: Record<string, unknown> = {};
      for (const [key, url] of Object.entries(urls)) out[key] = await net.fetch(url).then((response) => response.status, () => "failed");
      const whole = await net.fetch(video);
      out.videoType = whole.headers.get("content-type");
      const part = await net.fetch(video, { headers: { Range: "bytes=0-99" } });
      out.range = [part.status, part.headers.get("content-range"), (await part.arrayBuffer()).byteLength];
      return out;
    }, {
      video: src!,
      urls: {
        board: at(pathToFileURL(board).href),
        notes: at(pathToFileURL(notes).href),
        unnamed: at(pathToFileURL(unnamed).href),
        passwd: at("file:///etc/passwd"),
        dotdot: at(`${pathToFileURL(artifacts).href}/../../unnamed.png`),
      },
    });
    expect(served).toEqual({
      board: 200, notes: 404, unnamed: 404, passwd: 404, dotdot: 404,
      videoType: "video/mp4", range: [206, "bytes 0-99/4096", 100],
    });
  } finally {
    await app.close();
  }
});
