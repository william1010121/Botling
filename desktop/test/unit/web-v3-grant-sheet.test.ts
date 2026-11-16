// @vitest-environment jsdom
// M5-14b (D54, §11.7): the grant sheet on the page, "This device › Plugins". The shell shows it, never a plugin frame; one
// `plugin.grant` per server that holds the shown code hash, no `via`, no higher tier pre-ticked. No browser, no window.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeLink } from "../../src/fe-link";
import { slotKey } from "../../src/protocol";
import type { PluginRow } from "../../src/protocol/table-rows";
import type { Connection } from "../../web-v3/shell/connection";
import type { DeviceRecord } from "../../web-v3/shell/device-store";
import { grantCommands, listPlugins, pluginSheet, type PluginSource } from "../../web-v3/shell/plugins";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../web-v3/bridge-v3", () => ({ mountRenderer: () => ({ render() {}, unmount() {}, store: { resync: async () => undefined } }) }));
vi.mock("../../web-v3/shell/content-cache", () => ({ CONTENT_CACHE_CAP: 200 * 1024 * 1024, ContentCache: class { async clear() {} }, clearContentCache: async () => undefined }));
vi.mock("../../web-v3/shell/media", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../web-v3/shell/media")>()), MediaBroker: class { start() {} stop() {} setPath() {} dropCached() {} } }));
vi.mock("../../web-v3/shell/sw-bridge", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../web-v3/shell/sw-bridge")>()), SwBridge: class { start() {} stop() {} } }));
vi.mock("../../web-v3/shell/uploads", () => ({ PageUploads: class { start() {} stop() {} } }));

const SRV_A = "srva-000000000000000000000";
const SRV_B = "srvb-000000000000000000000";
const HASH = "sha256:aaaa1111";
const HASH_B = "sha256:bbbb2222";

function manifest(tier: PluginRow["manifest"]["tier"], requests: PluginRow["manifest"]["requests"] = []): PluginRow["manifest"] {
  return { tier, reads: [], requests, owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] };
}
function row(over: Partial<PluginRow> & { manifest?: PluginRow["manifest"] } = {}): PluginRow {
  return { codeHash: HASH, manifest: manifest("request", ["chat.send"]), author: "user", grants: {}, ...over };
}
function grant(tier: "read" | "request" | "write", grantedBy: "user" | "builtin" = "user"): PluginRow["grants"][string] {
  return { tier, reads: [], requests: tier === "read" ? [] : ["chat.send"], grantedBy, at: 1 };
}

/** A fake rows provider: the attached server has no rows here (M5-14e), peers do. */
function source(tables: Record<string, Record<string, unknown> | null>, names: Record<string, string> = { [SRV_A]: "studio", [SRV_B]: "build-box" }): PluginSource {
  return {
    servers: () => Object.keys(tables).map((id) => ({ id, name: names[id] ?? id })),
    rows: (id) => (tables[id] ? new Map(Object.entries(tables[id]!)) : null),
  };
}

describe("M5-14b plugins.ts (pure model)", () => {
  it("lists a plugin once across servers, with the author word and the granted tier word", () => {
    const src = source({
      [SRV_A]: { "plugin:note": row({ author: "builtin", manifest: manifest("write"), grants: { [HASH]: grant("write", "builtin") } }), "plugin:coach": row({ grants: { [HASH]: grant("read") } }) },
      [SRV_B]: { "plugin:coach": row({ grants: { [HASH]: grant("read") } }) },
    });
    const list = listPlugins(src);
    expect(list.map((p) => p.name)).toEqual(["coach", "note"]);
    expect(list[0]).toMatchObject({ authorWords: "added by you", tierWords: "read only", builtIn: false });
    expect(list[1]).toMatchObject({ authorWords: "built in", tierWords: "can change its own data", builtIn: true });
  });

  it("author words: builtin, user, bot, import", () => {
    const src = source({
      [SRV_A]: {
        "plugin:a": row({ author: "builtin", grants: { [HASH]: grant("read", "builtin") } }), "plugin:b": row({ author: "user" }),
        "plugin:c": row({ author: "bot" }), "plugin:d": row({ author: "import" }),
      },
    });
    expect(listPlugins(src).map((p) => p.authorWords)).toEqual(["built in", "added by you", "written by a bot", "from Botling 2"]);
  });

  it("reports the servers this page has no rows for, and ignores rows that are not a valid plugin row", () => {
    const src = source({ [SRV_A]: null, [SRV_B]: { "plugin:bad": { nope: true }, "plugin:ok": row() } });
    expect(listPlugins(src).map((p) => p.name)).toEqual(["ok"]);
    expect(pluginSheet(src, "ok")?.unreadServers).toEqual(["studio"]);
  });
});

describe("M5-14b sheet model and commands", () => {
  it("1. two servers hold the same hash: two plugin.grant items, targets srv:A and srv:B, no via", () => {
    const src = source({ [SRV_A]: { "plugin:coach": row() }, [SRV_B]: { "plugin:coach": row() } });
    const sheet = pluginSheet(src, "coach")!;
    expect(sheet.title).toBe("coach (on studio, build-box)");
    const sent = grantCommands(sheet, "request");
    expect(sent.map((item) => item.target)).toEqual([`srv:${SRV_A}`, `srv:${SRV_B}`]);
    for (const item of sent) {
      expect(item.cmd).toEqual({ type: "plugin.grant", plugin: "coach", codeHash: HASH, tier: "request", reads: [], requests: ["chat.send"] });
      expect(item).not.toHaveProperty("via");
    }
  });

  it("2. a different hash on B: only A gets one, and B is listed with its own line", () => {
    const src = source({ [SRV_A]: { "plugin:coach": row() }, [SRV_B]: { "plugin:coach": row({ codeHash: HASH_B }) } });
    const sheet = pluginSheet(src, "coach")!;
    expect(sheet.differing).toEqual(["build-box: a different version (cannot be allowed together)"]);
    expect(grantCommands(sheet, "request").map((item) => item.target)).toEqual([`srv:${SRV_A}`]);
  });

  it("4. options above the ask are absent", () => {
    const read = pluginSheet(source({ [SRV_A]: { "plugin:p": row({ manifest: manifest("read") }) } }), "p")!;
    expect(read.options.map((o) => o.tier)).toEqual(["read"]);
    const request = pluginSheet(source({ [SRV_A]: { "plugin:p": row({ manifest: manifest("request", ["chat.send"]) }) } }), "p")!;
    expect(request.options.map((o) => o.words)).toEqual(["Read only", "Send what it asks for"]);
    const write = pluginSheet(source({ [SRV_A]: { "plugin:p": row({ manifest: manifest("write") }) } }), "p")!;
    expect(write.options.map((o) => o.words)).toEqual(["Read only", "Send what it asks for", "Change its own data on the server"]);
    expect(() => grantCommands(read, "write")).toThrow();
  });

  it("never pre-ticks a higher tier: nothing is ticked without a grant; the current grant is ticked when all agree", () => {
    expect(pluginSheet(source({ [SRV_A]: { "plugin:p": row() } }), "p")!.selected).toBeNull();
    expect(pluginSheet(source({ [SRV_A]: { "plugin:p": row({ grants: { [HASH]: grant("read") } }) } }), "p")!.selected).toBe("read");
    const split = source({ [SRV_A]: { "plugin:p": row({ grants: { [HASH]: grant("read") } }) }, [SRV_B]: { "plugin:p": row({ grants: { [HASH]: grant("request") } }) } });
    expect(pluginSheet(split, "p")!.selected).toBeNull();
  });

  it("a built-in grant is shown as built in with no change; plugin.grant is never put in requests", () => {
    const builtin = source({ [SRV_A]: { "plugin:note": row({ author: "builtin", manifest: manifest("write"), grants: { [HASH]: grant("write", "builtin") } }) } });
    expect(pluginSheet(builtin, "note")).toMatchObject({ builtIn: true, options: [] });
    expect(() => grantCommands(pluginSheet(builtin, "note")!, "read")).toThrow();
    const odd = source({ [SRV_A]: { "plugin:p": row({ manifest: manifest("request", ["chat.send", "plugin.grant"]) }) } });
    expect(grantCommands(pluginSheet(odd, "p")!, "request")[0]!.cmd).toMatchObject({ requests: ["chat.send"] });
  });

  it("review: every target gets exactly the asks the sheet shows, never a target row's own wider manifest", () => {
    const wide = row({ manifest: manifest("request", ["chat.send", "settings.set"]) });
    const sheet = pluginSheet(source({ [SRV_A]: { "plugin:p": row() }, [SRV_B]: { "plugin:p": wide } }), "p")!;
    expect(sheet.askLine).not.toContain("settings.set");
    for (const item of grantCommands(sheet, "request")) expect(item.cmd.requests).toEqual(["chat.send"]);
  });

  it("re-review: a quote inside a reads item cannot close the quoting", () => {
    const m = { ...manifest("read"), reads: ['x"; it never sends; "y'] };
    const sheet = pluginSheet(source({ [SRV_A]: { "plugin:p": row({ manifest: m }) } }), "p")!;
    expect(sheet.askLine).toBe('It asks to: read the chat it is shown in; read "x\\"; it never sends; \\"y".');
  });

  it("review: reads are quoted and other requests say send, not use", () => {
    const m = { ...manifest("request", ["chat.send", "settings.set"]), reads: ["nothing else; it never sends"] };
    const sheet = pluginSheet(source({ [SRV_A]: { "plugin:p": row({ manifest: m }) } }), "p")!;
    expect(sheet.askLine).toBe('It asks to: read the chat it is shown in; read "nothing else; it never sends"; send messages in that chat (chat.send); send settings.set.');
  });

  it("review: the ask line never offers plugin.grant, and a read grant carries no requests", () => {
    const sheet = pluginSheet(source({ [SRV_A]: { "plugin:p": row({ manifest: manifest("request", ["chat.send", "plugin.grant"]) }) } }), "p")!;
    expect(sheet.askLine).not.toContain("plugin.grant");
    expect(grantCommands(sheet, "read")[0]!.cmd.requests).toEqual([]);
  });
});

interface Sent { target: string; cmd: Record<string, unknown>; extra: unknown[] }

function makeConnection(tables: Record<string, Record<string, unknown> | null>, sent: Sent[], failOnce?: string): Connection {
  let failing = failOnce;
  const names: Record<string, string> = { [SRV_A]: "studio", [SRV_B]: "build-box" };
  let n = 0;
  const pendings: Array<{ key: string; slot: unknown; state: string; cmd: unknown; lost: boolean; sending: boolean; createdAt: number; owner: string }> = [];
  const link = {
    attached: true,
    attachedServerId: () => SRV_A,
    servers: () => Object.keys(tables).map((id) => ({ id, name: names[id] ?? id, state: "live", since: null, self: id === SRV_A })),
    table: (id: string) => (tables[id] ? { logId: "l", rev: 1, rows: new Map(Object.entries(tables[id]!)), caught: true } : null),
    pending: () => pendings,
    on: () => () => undefined,
    submit: async (target: string, cmd: Record<string, unknown>, ...extra: unknown[]) => {
      if (failing === target) { failing = undefined; throw new Error("outbox is full"); }
      sent.push({ target, cmd, extra });
      const slot = { origin: "dev1", originEpoch: "e".repeat(32), target, n: ++n } as never;
      pendings.push({ key: slotKey(slot), slot, state: "delivered", cmd, lost: false, sending: false, createdAt: 1, owner: target.slice(4) });
      return { slot };
    },
  } as unknown as FeLink;
  return { link, port: link as unknown as Connection["port"], path: "direct", revoked: false, serverId: SRV_A, close: async () => undefined };
}

function device(scope: string[]): DeviceRecord {
  return { v: 1, memberId: "dev1", name: "Phone", signKey: {} as CryptoKey, signPub: "s", dhKey: {} as CryptoKey, dhPub: new Uint8Array(32), cluster: "c".repeat(32), server: { memberId: SRV_A, name: "studio", dhPub: new Uint8Array(32) }, addId: "a".repeat(32), scope: scope as DeviceRecord["scope"], pairedAt: 1 };
}

const roots: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(async () => {
  for (const item of roots.splice(0)) { await act(async () => { item.root.unmount(); }); item.el.remove(); }
});

async function mountSheet(scope: string[], tables: Record<string, Record<string, unknown> | null>, sent: Sent[], failOnce?: string): Promise<HTMLElement> {
  const { PluginsSheet } = await import("../../web-v3/shell/Shell");
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push({ root, el });
  await act(async () => { root.render(createElement(PluginsSheet, { device: device(scope), connection: makeConnection(tables, sent, failOnce), onClose: () => undefined })); });
  return el;
}
const click = async (button: Element) => { await act(async () => { (button as HTMLElement).click(); }); };
const buttonNamed = (el: HTMLElement, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === text)!;

describe("M5-14b the sheet in Shell.tsx", () => {
  // The attached server (SRV_A) has no rows on the page until M5-14e, so these tests put the plugin on two peers.
  const SRV_C = "srvc-000000000000000000000";
  const peers = (a: PluginRow, b: PluginRow) => ({ [SRV_A]: null, [SRV_B]: { "plugin:coach": a }, [SRV_C]: { "plugin:coach": b } });

  it("shows the list, the Review sheet, and sends one plugin.grant per machine after Allow, then 'Sent to 2 machines.'", async () => {
    const sent: Sent[] = [];
    const el = await mountSheet(["read", "reply", "manage"], peers(row({ grants: { [HASH]: grant("read") } }), row({ grants: { [HASH]: grant("read") } })), sent);
    expect(el.querySelector("h2")!.textContent).toBe("This device › Plugins");
    expect(el.textContent).toContain("coach");
    expect(el.textContent).toContain("added by you");
    expect(el.textContent).toContain("read only");
    await click(buttonNamed(el, "Review"));
    expect(el.textContent).toContain("It asks to:");
    expect(el.textContent).toContain("send messages in that chat (chat.send)");
    expect(el.textContent).toContain("Allow it to:");
    const radios = [...el.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    await click(radios[1]!);
    await click(buttonNamed(el, "Allow"));
    expect(sent.map((s) => s.target)).toEqual([`srv:${SRV_B}`, `srv:${SRV_C}`]);
    expect(sent.every((s) => s.extra.length === 0 && s.cmd.tier === "request")).toBe(true);
    expect(el.textContent).toContain("Sent to 2 machines.");
    expect(el.textContent).toContain("build-box: delivered");
  });

  it("review: a double tap on Allow sends one plugin.grant per machine, not two", async () => {
    const sent: Sent[] = [];
    const el = await mountSheet(["read", "reply", "manage"], peers(row({ grants: { [HASH]: grant("read") } }), row({ grants: { [HASH]: grant("read") } })), sent);
    await click(buttonNamed(el, "Review"));
    const allow = buttonNamed(el, "Allow");
    await act(async () => { allow.click(); allow.click(); });
    expect(sent.map((s) => s.target)).toEqual([`srv:${SRV_B}`, `srv:${SRV_C}`]);
  });

  it("review: after a part-way failure what was sent stays, and Allow again sends only to the machine that has not got it", async () => {
    const sent: Sent[] = [];
    const el = await mountSheet(["read", "reply", "manage"], peers(row({ grants: { [HASH]: grant("read") } }), row({ grants: { [HASH]: grant("read") } })), sent, `srv:${SRV_C}`);
    await click(buttonNamed(el, "Review"));
    await click(buttonNamed(el, "Allow"));
    expect(sent.map((s) => s.target)).toEqual([`srv:${SRV_B}`]);
    expect(el.textContent).toContain("outbox is full");
    expect(el.textContent).toContain("Sent to 1 machine.");
    await click(buttonNamed(el, "Allow"));
    expect(sent.map((s) => s.target)).toEqual([`srv:${SRV_B}`, `srv:${SRV_C}`]);
    expect(el.textContent).toContain("Sent to 2 machines.");
    expect(buttonNamed(el, "Allow")).toBeUndefined();
    // Leaving and reviewing again does not send either machine a second time.
    await click(buttonNamed(el, "Done"));
    await click(buttonNamed(el, "Review"));
    expect(buttonNamed(el, "Allow")).toBeUndefined();
    expect(sent).toHaveLength(2);
  });

  it("re-review: after sending request, Done then Review again shows it sent and locked, and sends nothing more", async () => {
    const sent: Sent[] = [];
    const el = await mountSheet(["read", "reply", "manage"], peers(row({ grants: { [HASH]: grant("read") } }), row({ grants: { [HASH]: grant("read") } })), sent);
    await click(buttonNamed(el, "Review"));
    await click([...el.querySelectorAll<HTMLInputElement>("input[type=radio]")][1]!);
    await click(buttonNamed(el, "Allow"));
    expect(sent.map((s) => s.cmd.tier)).toEqual(["request", "request"]);
    await click(buttonNamed(el, "Done"));
    await click(buttonNamed(el, "Review"));
    const allow = buttonNamed(el, "Allow");
    if (allow) await click(allow);
    expect(sent.map((s) => s.cmd.tier)).toEqual(["request", "request"]);
  });

  it("re-review: a part-way failure at request, then Done and Review: the retry still sends request, only to the missing machine", async () => {
    const sent: Sent[] = [];
    const el = await mountSheet(["read", "reply", "manage"], peers(row({ grants: { [HASH]: grant("read") } }), row({ grants: { [HASH]: grant("read") } })), sent, `srv:${SRV_C}`);
    await click(buttonNamed(el, "Review"));
    await click([...el.querySelectorAll<HTMLInputElement>("input[type=radio]")][1]!);
    await click(buttonNamed(el, "Allow"));
    await click(buttonNamed(el, "Done"));
    await click(buttonNamed(el, "Review"));
    const radios = [...el.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    expect(radios.map((r) => [r.checked, r.disabled])).toEqual([[false, true], [true, true]]);
    expect(el.textContent).toContain("Sent to 1 machine.");
    const allow = buttonNamed(el, "Allow");
    if (allow) await click(allow);
    expect(sent.map((s) => `${s.target.slice(4, 8)}:${s.cmd.tier}`)).toEqual(["srvb:request", "srvc:request"]);
  });

  it("re-review: a radio change while Allow is sending cannot split the act or unlock another tier", async () => {
    const sent: Sent[] = [];
    const el = await mountSheet(["read", "reply", "manage"], peers(row({ grants: { [HASH]: grant("read") } }), row({ grants: { [HASH]: grant("read") } })), sent);
    await click(buttonNamed(el, "Review"));
    await click([...el.querySelectorAll<HTMLInputElement>("input[type=radio]")][1]!);
    const allow = buttonNamed(el, "Allow");
    await act(async () => { allow.click(); [...el.querySelectorAll<HTMLInputElement>("input[type=radio]")][0]!.click(); });
    expect(sent.map((s) => s.cmd.tier)).toEqual(["request", "request"]);
    expect([...el.querySelectorAll<HTMLInputElement>("input[type=radio]")].map((r) => [r.checked, r.disabled])).toEqual([[false, true], [true, true]]);
    expect(buttonNamed(el, "Allow")).toBeUndefined();
  });

  it("re-review: when the first send fails nothing is locked, and the user may pick another tier", async () => {
    const sent: Sent[] = [];
    const el = await mountSheet(["read", "reply", "manage"], peers(row({ grants: { [HASH]: grant("read") } }), row({ grants: { [HASH]: grant("read") } })), sent, `srv:${SRV_B}`);
    await click(buttonNamed(el, "Review"));
    await click([...el.querySelectorAll<HTMLInputElement>("input[type=radio]")][1]!);
    await click(buttonNamed(el, "Allow"));
    expect(sent).toEqual([]);
    expect(el.textContent).toContain("outbox is full");
    expect([...el.querySelectorAll<HTMLInputElement>("input[type=radio]")].map((r) => r.disabled)).toEqual([false, false]);
  });

  it("3. a device without manage: no Review button and no submit, the text shown", async () => {
    const sent: Sent[] = [];
    const el = await mountSheet(["read", "reply"], peers(row(), row()), sent);
    expect(buttonNamed(el, "Review")).toBeUndefined();
    expect(el.textContent).toContain("Only a device allowed to manage can change this.");
    expect(sent).toEqual([]);
  });

  it("a built-in plugin has no Review button even for a manage device", async () => {
    const sent: Sent[] = [];
    const note = row({ author: "builtin", manifest: manifest("write"), grants: { [HASH]: grant("write", "builtin") } });
    const el = await mountSheet(["read", "reply", "manage"], { [SRV_A]: null, [SRV_B]: { "plugin:note": note } }, sent);
    expect(el.textContent).toContain("built in");
    expect(el.textContent).toContain("can change its own data");
    expect(buttonNamed(el, "Review")).toBeUndefined();
  });

  it("the sheet lists a machine whose hash differs, and Cancel goes back without sending", async () => {
    const sent: Sent[] = [];
    const el = await mountSheet(["read", "reply", "manage"], peers(row(), row({ codeHash: HASH_B })), sent);
    await click(buttonNamed(el, "Review"));
    expect(el.textContent).toContain("srvc-000000000000000000000: a different version (cannot be allowed together)");
    await click(buttonNamed(el, "Cancel"));
    expect(el.textContent).not.toContain("Allow it to:");
    expect(sent).toEqual([]);
  });
});

describe("a plugin that waits for the user's Allow cannot be missed (2026-11-16)", () => {
  const SRV_C = "srvc-000000000000000000000";
  const tables = { [SRV_A]: null, [SRV_B]: { "plugin:aaa": row({ grants: { [HASH]: grant("read") } }), "plugin:zzz": row({ author: "bot" }) }, [SRV_C]: { "plugin:aaa": row({ grants: { [HASH]: grant("read") } }), "plugin:zzz": row({ author: "bot" }) } };

  it("listPlugins marks a plugin with no grant at its hash (not a built-in one) as needing Allow", () => {
    const list = listPlugins(source({ [SRV_A]: { "plugin:note": row({ author: "builtin", grants: {} }), "plugin:ok": row({ grants: { [HASH]: grant("read") } }), "plugin:new": row({ author: "bot" }) } }));
    expect(Object.fromEntries(list.map((p) => [p.name, p.needsAllow]))).toEqual({ new: true, note: false, ok: false });
  });

  it("the sheet lists it first with a banner and a primary Review button, though its name sorts last", async () => {
    const sent: Sent[] = [];
    const el = await mountSheet(["read", "reply", "manage"], tables, sent);
    expect(el.querySelector('[data-testid="plugins-banner"]')?.textContent).toBe("1 plugin is waiting for your Allow.");
    const rows = [...el.querySelectorAll('[data-testid="plugin-row"]')];
    expect(rows.map((r) => r.querySelector(".v3-plugin-name")?.textContent)).toEqual(["zzz", "aaa"]);
    expect(rows[0]!.textContent).toContain("waiting for your Allow");
    expect(rows[0]!.querySelector("button")?.className).toBe("web-primary");
    expect(rows[1]!.querySelector("button")?.className).toBe("web-secondary");
  });

  it("without one, there is no banner", async () => {
    const calm = { [SRV_A]: null, [SRV_B]: { "plugin:aaa": row({ grants: { [HASH]: grant("read") } }) } };
    const el = await mountSheet(["read", "reply", "manage"], calm, []);
    expect(el.querySelector('[data-testid="plugins-banner"]')).toBeNull();
  });
});
