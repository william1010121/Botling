import { beforeEach, describe, expect, it } from "vitest";
import { activate as latex } from "../plugins/ccb-latex/src/web";
import { sent } from "../src/bridge";
import { Composer } from "../src/composer";
import { messageElement } from "../src/messages";
import { matches, PluginHost, type PluginSpec } from "../src/plugins";
import type { MessageView } from "../src/types";

function message(overrides: Partial<MessageView>): MessageView {
  return {
    id: "m1", role: "bot", text: "", stamp: null, avatar: null,
    choices: null, chosen: null, answer: null, open: false, display: null,
    attachments: null, replyTo: null, replyPreview: null, openable: false,
    ...overrides,
  };
}

function spec(name: string, overrides: Partial<PluginSpec> = {}): PluginSpec {
  return { name, version: "1.0.0", source: "", styles: [], settings: {}, commands: [], ...overrides };
}

let redraws = 0;
let host: PluginHost;
let composer: Composer;

beforeEach(() => {
  sent.length = 0;
  redraws = 0;
  document.body.innerHTML = "";
  const slot = document.createElement("div");
  document.body.append(slot);
  composer = new Composer(slot);
  host = new PluginHost({
    composer: {
      element: composer.root,
      view: composer.view,
      getText: () => composer.text,
      insert: (text) => composer.insert(text),
      addExtension: (extension) => composer.addExtension(extension),
      showPopover: (content) => composer.showPopover(content),
    },
    redraw: () => { redraws += 1; },
  });
  composer.onKey = (event) => host.handleKey(event);
});

describe("plugin host", () => {
  it("ccb-latex typesets bot replies and your own messages, and stops when unloaded", async () => {
    await host.sync([spec("ccb-latex")], async () => latex);
    expect(redraws).toBe(1);
    expect(messageElement(message({ text: "See $x^2$" }), {}).querySelector(".katex")).not.toBeNull();
    expect(messageElement(message({ role: "user", text: "Mine $y$" }), {}).querySelector(".user-bubble .katex")).not.toBeNull();

    await host.sync([], async () => latex);
    expect(host.isLoaded("ccb-latex")).toBe(false);
    expect(redraws).toBe(2);
    expect(messageElement(message({ text: "See $x^2$" }), {}).querySelector(".katex")).toBeNull();
  });

  it("a plugin that throws on load is reported, and the chat keeps working", async () => {
    await host.sync([spec("broken")], async () => () => { throw new Error("boom"); });
    expect(host.isLoaded("broken")).toBe(false);
    expect(sent).toContainEqual({ type: "pluginError", name: "broken", message: "boom" });
  });

  it("a renderer that throws unloads its plugin but the message is still drawn", async () => {
    await host.sync([spec("bad-render")], async () => (ccb) => {
      ccb.messages.afterRender(() => { throw new Error("render failed"); });
    });
    const row = messageElement(message({ text: "**Still here**" }), {});
    expect(row.querySelector("strong")?.textContent).toBe("Still here");
    expect(host.isLoaded("bad-render")).toBe(false);
    expect(sent).toContainEqual({ type: "pluginError", name: "bad-render", message: "render failed" });
  });

  it("plugins change the input box: key presses, insert, extensions", async () => {
    const keys: string[] = [];
    await host.sync([spec("keys")], async () => (ccb) => {
      ccb.composer.onKeyDown((event) => {
        keys.push(event.key);
        if (event.key === ";") { ccb.composer.insert("\\alpha"); return true; }
      });
    });
    composer.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: ";", bubbles: true }));
    expect(keys).toEqual([";"]);
    expect(composer.text).toBe("\\alpha");
  });

  it("registers components that bots show", async () => {
    await host.sync([spec("meter")], async () => (ccb) => {
      ccb.components.register("meter", (root, data) => { root.textContent = `${(data as { value: number }).value}%`; });
    });
    const row = messageElement(message({ text: "Progress", display: { name: "meter", data: '{"value":40}' } }), {});
    expect(row.querySelector(".plugin-component")?.textContent).toBe("40%");
  });

  it("draws every component a reply shows, each where it was written", async () => {
    const answers: unknown[] = [];
    await host.sync([spec("meter")], async () => (ccb) => {
      ccb.components.register("meter", (root, data, answer) => {
        const value = (data as { value: number }).value;
        root.textContent = `${value}%`;
        root.addEventListener("click", () => answer(`picked ${value}`));
      });
    });
    const text = "First\n\nSecond\n\nLast";
    const row = messageElement(message({
      id: "m9",
      text,
      display: null,
      displays: [
        { name: "meter", data: '{"value":10}', at: text.indexOf("Second") },
        { name: "meter", data: '{"value":20}', at: text.indexOf("Last") },
        { name: "meter", data: '{"value":30}', at: null },
      ],
    }), {});
    const parts = [...row.querySelectorAll(".markdown, .plugin-component")].map((element) => element.textContent?.trim());
    expect(parts).toEqual(["First", "10%", "Second", "20%", "Last", "30%"]);
    (row.querySelectorAll(".plugin-component")[1] as HTMLElement).click();
    expect(sent.at(-1)).toEqual({ type: "answer", messageID: "m9", text: "picked 20" });
    void answers;
  });

  it("runs commands from their shortcut and tells plugins when settings change", async () => {
    const seen: unknown[] = [];
    let ran = 0;
    const activate = async () => (ccb: Parameters<typeof latex>[0]) => {
      ccb.commands.register("tool.run", () => { ran += 1; });
      ccb.settings.onChange("tool.mode", (value) => seen.push(value));
    };
    const commands = [{ id: "tool.run", title: "Run", key: "cmd+shift+l" }];
    await host.sync([spec("tool", { commands, settings: { "tool.mode": "a" } })], activate);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "L", metaKey: true, shiftKey: true }));
    expect(ran).toBe(1);
    await host.sync([spec("tool", { commands, settings: { "tool.mode": "b" } })], activate);
    expect(seen).toEqual(["b"]);
    expect(host.isLoaded("tool")).toBe(true);
  });

  it("matches shortcut keys exactly", () => {
    expect(matches("cmd+shift+l", new KeyboardEvent("keydown", { key: "l", metaKey: true, shiftKey: true }))).toBe(true);
    expect(matches("cmd+shift+l", new KeyboardEvent("keydown", { key: "l", metaKey: true }))).toBe(false);
  });
});

describe("plugin host calls from the page", () => {
  it("host.call goes to Swift and resolves with the answer", async () => {
    let call: Promise<unknown> | null = null;
    await host.sync([spec("asker")], async () => (ccb) => { call = ccb.host.call("count", { n: 2 }); });
    const request = sent.find((action) => action.type === "hostCall") as { callID: number; plugin: string; method: string; params: unknown };
    expect(request).toMatchObject({ plugin: "asker", method: "count", params: { n: 2 } });
    host.hostReply(request.callID, true, 3);
    await expect(call).resolves.toBe(3);
  });

  it("a command no web part has goes to the plugin host", () => {
    host.execute("other.run");
    expect(sent).toContainEqual({ type: "command", id: "other.run" });
  });
});

describe("panels", () => {
  it("a plugin registers a panel and it can be drawn", async () => {
    const { extensions } = await import("../src/messages");
    await host.sync([spec("charts")], async () => (ccb) => {
      ccb.panels.register("today", (root) => { root.textContent = "3 things today"; });
    });
    const panel = extensions.panels.get("charts/today");
    const root = document.createElement("div");
    panel?.render(root);
    expect(root.textContent).toBe("3 things today");
    await host.sync([], async () => () => {});
    expect(extensions.panels.has("charts/today")).toBe(false);
  });
});
