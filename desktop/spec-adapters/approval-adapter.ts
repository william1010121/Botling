// spec/driver/approval-driver.ts against the real code (in jsdom): the app page's ApprovalSheet
// (`useApprovalSheet`), its FrameBroker with the plugin frame registered through plugin-frame-host.ts, and
// the core's Plugins (`approvalAsk`, `approve`) behind a Client, with a world that keeps approved commands.
// The frame is an iframe whose messages the test dispatches. Translation only.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type BotView, type Command } from "../src/contract";
import { Plugins, type PluginWorld } from "../src/core/plugins";
import { useApprovalSheet } from "../src/renderer/ApprovalSheet";
import { Client } from "../src/renderer/client";
import { FrameBroker, registerPluginFrame } from "../src/renderer/frame-broker";
import { pluginFrameHost } from "../src/renderer/plugin-frame-host";
import type { ApprovalDriver, ApprovalSession, ApprovalWorld } from "../../spec/driver/approval-driver";
import type { Answer, Cmd, Folder, Slot, View } from "../../spec/reference/approval";

const PLUGIN = "botling.whiteboard";
const BOT = "5EC00000-0000-4000-8000-0000000000B1";
const FOLDER = "/p/site";
const ARM_MS = 500;

export const approvalAdapter: ApprovalDriver = {
  async open(world: ApprovalWorld): Promise<ApprovalSession> {
    const commands: Record<Cmd, string> = Object.fromEntries(world.cmds.map((c, i) => [c, `echo spec-${i} ${c}`]));
    const cmdOf = (command: string) => world.cmds.find((c) => commands[c] === command) ?? null;
    const folders: Record<Folder, string> = { own: FOLDER, other: "/" };
    const settled = async () => { for (let i = 0; i < 8; i++) await world.wait(0); };

    const dataDir = mkdtempSync(join(tmpdir(), "spec-approval-"));
    mkdirSync(join(dataDir, "plugins", PLUGIN), { recursive: true });
    writeFileSync(join(dataDir, "plugins", PLUGIN, "package.json"), JSON.stringify({ name: PLUGIN, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: {} }));
    const approved = new Set<string>();
    const pluginWorld: PluginWorld = {
      bots: () => [], send: () => ({ messageId: "" }), interrupt: async () => null, notice: () => {}, ask: () => new Promise(() => {}), openPanel: () => {},
      appSettings: () => ({}), shortcutOverrides: () => ({}), createBot: () => { throw new Error("no"); }, addRoutine: () => "no-bot",
      commandApproval: (botId, command) => (botId === BOT ? { folder: FOLDER, approved: approved.has(command) } : null),
      approveCommand: (botId, command) => botId === BOT && !!approved.add(command),
      commandRun: () => null, component: () => null, imageUrls: () => null,
      changed: () => {}, broken: () => {}, log: () => {},
      workspace: { bots: () => [], memory: () => { throw new Error("not here"); }, tasks: () => [], taskHistory: () => [], results: () => [], waiting: () => ({ items: [], doing: {} }), ignoreWaiting: () => {}, pendingApprovals: () => [], face: () => "" },
      workspaceWatch: () => {},
    };
    const plugins = new Plugins({ dataDir, world: pluginWorld, node: null, hostScript: "", sealer: null });

    // The app page's client: plugins.* go to the core's Plugins; a refusal is an error response.
    let receive: (value: unknown) => void = () => {};
    const core = (cmd: Command): unknown => {
      if (cmd.type === "plugins.approvalAsk") return plugins.approvalAsk(cmd.name, cmd.botId, cmd.command, cmd.folder, cmd.card);
      if (cmd.type === "plugins.approve") return plugins.approve(cmd.name, cmd.botId, cmd.command, cmd.folder);
      throw Object.assign(new Error(`not here: ${cmd.type}`), { code: "not_found" });
    };
    const client = new Client({ protocol: PROTOCOL_VERSION, subscribe(listener) { receive = listener; return () => {}; }, post(envelope: any) {
      let response: unknown;
      try { response = { ok: true, result: core(envelope.cmd) }; } catch (error) { response = { ok: false, error: { code: (error as { code?: string }).code ?? "conflict", message: (error as Error).message } }; }
      queueMicrotask(() => receive({ v: PROTOCOL_VERSION, id: envelope.id, ...(response as object) }));
    } });

    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let ask: ReturnType<typeof useApprovalSheet>["ask"] = () => {};
    function Page() {
      const sheet = useApprovalSheet(client, "en", () => {}, ARM_MS);
      ask = sheet.ask;
      return createElement("div", null, sheet.sheet);
    }
    await act(async () => root.render(createElement(Page)));

    const broker = new FrameBroker(window, { name: "spec panel broker" });
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const replies = new Map<number, { ok: boolean; value: unknown }>();
    frame.contentWindow!.postMessage = ((message: { id: number; ok: boolean; value: unknown }) => { replies.set(message.id, message); }) as Window["postMessage"];
    const bots = [{ id: BOT, role: "manager", name: "Site" }] as BotView[];
    registerPluginFrame(broker, pluginFrameHost({ client, components: () => ({}), bots: () => bots, ask: (...args) => ask(...args) }), { frame, plugin: PLUGIN });

    const ids = new Map<Slot, number>();
    let next = 0;
    const button = (selector: string) => document.querySelector<HTMLButtonElement>(selector);
    const click = async (selector: string) => { await act(async () => { button(selector)?.click(); await settled(); }); };

    return {
      async ask(slot, cmd, folder) {
        const id = ++next;
        ids.set(slot, id);
        await act(async () => {
          window.dispatchEvent(new MessageEvent("message", { data: { ccb: "approval", id, botId: BOT, command: commands[cmd], folder: folders[folder] }, origin: "null", source: frame.contentWindow }));
          await settled();
        });
      },
      strayClick: () => click(".approval-allow"),
      async arm() { await act(async () => { await world.wait(ARM_MS); await settled(); }); },
      allow: () => click(".approval-allow"),
      cancel: () => click(".dialog-cancel"),
      observe(): View {
        const answers: Record<Slot, Answer> = Object.fromEntries(world.slots.map((slot) => {
          const reply = ids.has(slot) ? replies.get(ids.get(slot)!) : undefined;
          return [slot, !reply ? null : !reply.ok ? "refused" : (reply.value as { allowed: boolean }).allowed ? "allowed" : "notAllowed"];
        }));
        const shown = document.querySelector(".approval-command")?.textContent ?? null;
        return {
          sheet: shown === null ? null : cmdOf(shown),
          armed: !!button(".approval-allow") && !button(".approval-allow")!.disabled,
          approved: [...approved].map(cmdOf).filter((c): c is Cmd => c !== null).sort(),
          answers,
        };
      },
      async close() {
        broker.dispose();
        await act(async () => root.unmount());
        document.body.innerHTML = "";
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
        await plugins.shutdown();
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
  },
};
