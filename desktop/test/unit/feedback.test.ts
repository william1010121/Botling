// "Not right" on a reply in developer mode (Phase 5a; 1.x's Workspace+Developer.swift `reportFeedback`):
// the report goes to the developer project with the chat around it, word for word as 1.x writes it
// (test/fixtures/phase5-golden.json), the screenshot and pictures kept with it; feedback.md keeps them all.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import { parseFeedback } from "../../src/core/feedback";

const golden = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "phase5-golden.json"), "utf8")).more.feedback;
const harnesses: CoreHarness[] = [];
afterEach(async () => { for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null) await harness.kill("SIGTERM"); });

describe("feedback relays (reportFeedback)", () => {
  it("goes to the developer project as 1.x words it, with the screenshot and pictures; nothing without developer mode", async () => {
    const dir = tempDir("feedback");
    // The main bot's chat as the Swift run had it, up to the flagged reply.
    const lines = golden.messages as any[];
    const upTo = lines.findIndex((line) => line.id === "00000000-0000-4000-8000-0000000000C2");
    mkdirSync(join(dir, "main"), { recursive: true });
    writeFileSync(join(dir, "main", "chat.json"), JSON.stringify(lines.slice(0, upTo + 1)));
    const folder = join(tempDir("feedback-shop"), "Shop");
    mkdirSync(folder, { recursive: true });
    const c = new CoreHarness(dir, { TZ: "UTC" });
    harnesses.push(c);
    const { botId: shop } = await c.call({ type: "projects.add", folder });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const flag = (text: string, messageId: string) => c.call({ type: "chat.feedback", botId: MAIN, messageId, text, images: [{ name: "mine.png", base64: png }], rect: null, screenshot: png });
    expect(await flag("x", "00000000-0000-4000-8000-0000000000C2")).toEqual({ sent: false });
    await c.call({ type: "settings.set", change: { key: "developerMode", value: true } });
    await c.call({ type: "settings.set", change: { key: "developerProject", value: shop } });
    expect(await flag("  It says none but one failed  ", "00000000-0000-4000-8000-0000000000C2")).toEqual({ sent: true });
    const relay = await until(async () => (await c.chat(shop)).messages.find((m: any) => m.role === "relay"));
    expect(relay.text).toBe(golden.relay);
    expect(relay.feedback).toEqual(golden.note);
    expect(relay.attachments).toHaveLength(2);
    await until(async () => (await c.chat()).messages.some((m: any) => m.role === "notice" && m.text === golden.notice && m.sourceId === shop));
    const kept = readFileSync(join(dir, "feedback.md"), "utf8");
    expect(kept).toMatch(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n\nFeedback: the user flagged a reply of Main bot as not right\./);
    expect(kept).toContain("\n\nAttachments:\n- " + join(folder, ".bot", "attachments"));
    // Parsed back from the text (1.x's relays saved before the note was kept).
    expect([parseFeedback(golden.relay), parseFeedback(golden.relayEmpty)]).toEqual(golden.parsed);
    expect(existsSync(join(dir, "incoming", "feedback.png"))).toBe(false);
  });
});
