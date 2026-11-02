// @vitest-environment node
// The host's side of reply tags and approvals (plugin-extraction.md W3, W4): a plugin hears the tags it declared
// (`replyTags.on`, only its own: Botling names the plugin), and asks Botling whether the user allowed a command
// (`approvals.check`); nothing in the api approves one.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Host, type BotlingApi, type HostPluginSpec, type ReplyTag } from "../src/host";

const scratch = mkdtempSync(join(tmpdir(), "ccb-host-tags-"));
const spec = (name: string): HostPluginSpec => ({ name, version: "1.0.0", main: "", fingerprint: "1", settings: {}, storageDir: join(scratch, name) });

describe("replyTags and approvals in the host", () => {
  it("a tag goes to the listeners of the plugin Botling names, until they are disposed; a listener that throws is reported", async () => {
    const heard: { plugin: string; tag: ReplyTag }[] = [];
    const offs: Record<string, () => void> = {};
    const written: any[] = [];
    const host = new Host((message) => written.push(message), async (s) => (api: BotlingApi) => {
      offs[s.name] = api.replyTags.on("deploy-status", (tag) => heard.push({ plugin: s.name, tag }));
      if (s.name === "b") api.replyTags.on("deploy-status", () => { throw new Error("broke"); });
    });
    await host.sync([spec("a"), spec("b")]);
    const bot = { id: "B1", name: "Site", role: "manager", awake: true };
    await host.receive({ method: "replyTag", params: { plugin: "a", bot, tag: "deploy-status", attributes: { env: "prod" }, body: "{}" } });
    expect(heard).toEqual([{ plugin: "a", tag: { bot, tag: "deploy-status", attributes: { env: "prod" }, body: "{}" } }]);
    await host.receive({ method: "replyTag", params: { plugin: "b", bot, tag: "deploy-status", attributes: {}, body: "" } });
    expect(written).toContainEqual({ method: "pluginError", params: { plugin: "b", message: "broke" } });
    // A notification gets no answer; another tag, or a plugin not loaded, reaches nobody.
    await host.receive({ method: "replyTag", params: { plugin: "a", bot, tag: "other-tag", attributes: {}, body: "" } });
    await host.receive({ method: "replyTag", params: { plugin: "ghost", bot, tag: "deploy-status", attributes: {}, body: "" } });
    expect(heard).toHaveLength(2);
    expect(written.some((message) => message.id !== undefined && message.method === undefined)).toBe(false);
    offs.a!();
    heard.length = 0;
    await host.receive({ method: "replyTag", params: { plugin: "a", bot, tag: "deploy-status", attributes: {}, body: "" } });
    await host.receive({ method: "replyTag", params: { plugin: "b", bot, tag: "deploy-status", attributes: {}, body: "" } });
    expect(heard.map((entry) => entry.plugin)).toEqual(["b"]);
  });

  it("approvals.check asks Botling, naming the plugin; there is no way to approve", async () => {
    let api!: BotlingApi;
    const written: any[] = [];
    const host = new Host((message) => written.push(message), async () => (given: BotlingApi) => { api = given; });
    await host.sync([spec("botling.whiteboard")]);
    const checked = api.approvals.check("B1", "git log");
    const request = written.find((message) => message.method === "approvals.check");
    expect(request.params).toEqual({ bot: "B1", command: "git log", plugin: "botling.whiteboard" });
    await host.receive({ id: request.id, result: { folder: "/p/site", approved: false } });
    expect(await checked).toEqual({ folder: "/p/site", approved: false });
    expect(Object.keys(api.approvals)).toEqual(["check"]);
  });
});
