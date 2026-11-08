// A bot called in with @ by another bot that starts a worker for the request reports back to the caller:
// the turns it takes on that worker's notes and reports are posted in the caller's chat and wake the caller,
// as its @ answer is. Its other turns (its own chat with the user) are not. The case is flux-k8s of
// 2026-11-08 20:00: it started worker `deploy-botling-relay` for botling's @, then asked (20:06) and reported
// the relay live (20:13) in its own chat only, and botling never heard.
import { describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import type { Bot } from "../../src/core/bot";
import { saveProjectRow } from "../../src/core/projects";
import { tempDir } from "../helpers";

const BOTLING = "98BDBF26-850C-4521-AEB4-CCF9073E8BD0";
const FLUX = "6AC64E3A-C7D7-4000-8000-000000000001";

function fixture() {
  const dir = tempDir("at-call-followup");
  const folder = tempDir("at-call-followup-botling");
  const fluxFolder = tempDir("at-call-followup-flux");
  for (const f of [folder, fluxFolder]) mkdirSync(join(f, ".bot"), { recursive: true });
  saveProjectRow(dir, { id: BOTLING, name: "botling", folder, avatar: "triangle" });
  saveProjectRow(dir, { id: FLUX, name: "flux-k8s", folder: fluxFolder, avatar: "cloud" });
  const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  const bots: Map<string, Bot> = (core as any).bots;
  const conversations = (core as any).conversations;
  const caller = bots.get(BOTLING)!, flux = bots.get(FLUX)!;
  const woken: string[] = [];
  vi.spyOn(caller, "appMessage").mockImplementation(((text: string) => { woken.push(text); return "m"; }) as any);
  vi.spyOn(caller, "appNotice").mockImplementation((() => "n") as any);
  // flux-k8s's turns are begun for real; only handing them to an agent is left out.
  vi.spyOn(flux as any, "deliver").mockImplementation(async () => {});
  return { core, conversations, caller, flux, woken };
}

/** flux-k8s's turn now ends with `text` as its reply. */
async function answer(flux: Bot, text: string, origin?: string) {
  await vi.waitFor(() => expect((flux as any).turn?.open && (!origin || (flux as any).turn.origin === origin)).toBe(true));
  const turn = (flux as any).turn;
  turn.reply.text = text;
  (flux as any).finishTurn(turn, "done");
}

const ASK = "@flux-k8s 中繼站的映像檔準備好了，請幫忙部署到 `relay.driseam.com`。部署好之後，請回傳網址和 `/healthz` 的結果給我。";
const fromFlux = (caller: Bot) => caller.lines().filter((line) => line.sourceID === FLUX).map((line) => line.text);

describe("a bot called in with @ that starts a worker reports back to the bot that called it", () => {
  it("relays its turns on that worker's question and report into the caller's chat and wakes the caller, not its other turns", async () => {
    const h = fixture();
    try {
      h.conversations.receiveBotMention({ id: "R1", role: "bot", text: ASK, date: 0 }, h.caller);
      await vi.waitFor(() => expect((h.flux as any).turn?.callIn).toBe(BOTLING));
      // Its call-in turn starts a worker (app_handoff), then answers.
      (h.flux as any).onWorkerOutput({ kind: "subagentStarted", id: "W1", description: "deploy-botling-relay", type: "claude-worker", prompt: "Deploy the relay.", background: true });
      await answer(h.flux, "已經開始部署：worker `deploy-botling-relay` …，我會再把網址和測試結果回報給你。");
      await vi.waitFor(() => expect(fromFlux(h.caller)).toHaveLength(1));
      expect(h.woken).toHaveLength(1);

      // 20:06: the worker's run ends blocked; flux-k8s's turn on that report asks a question with choices.
      (h.flux as any).workerReport("<app_task_result task_id=\"W1\">blocked: pull secret</app_task_result>", "W1");
      await answer(h.flux, "中繼站還沒上線，卡在 registry 的 pull secret。\n<choices><choice>用 keychain 的帳密</choice><choice>先不要</choice></choices>", "app");
      await vi.waitFor(() => expect(fromFlux(h.caller)).toHaveLength(2));
      expect(fromFlux(h.caller)[1]).toContain("pull secret");
      expect(h.woken).toHaveLength(2);
      expect(h.woken[1]).toContain("pull secret");
      expect(h.woken[1]).toContain("flux-k8s");

      // The user answers in flux-k8s's own chat: that turn is its own, not relayed.
      h.flux.send("授權我用 keychain 裡的 registry 帳密");
      await answer(h.flux, "已經交給同一個 worker 繼續。", "user");
      // 20:13: the same worker's next run reports; that turn is relayed.
      (h.flux as any).workerReport("<app_task_result task_id=\"W1\">done</app_task_result>", "W1");
      await answer(h.flux, "中繼站已經上線，網址是 `https://relay.driseam.com`。`/healthz` 回 200。", "app");
      await vi.waitFor(() => expect(fromFlux(h.caller)).toHaveLength(3));
      expect(fromFlux(h.caller)[2]).toContain("https://relay.driseam.com");
      expect(fromFlux(h.caller).join("\n")).not.toContain("已經交給同一個 worker");
      expect(h.woken).toHaveLength(3);
      expect(h.woken[2]).toContain("https://relay.driseam.com");
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("relays its turn on a note from that worker (app_notify_owner), and nothing for a worker it started in its own chat", async () => {
    const h = fixture();
    try {
      // A worker started in its own turn: its report stays in its own chat.
      h.flux.send("請部署 docs");
      await vi.waitFor(() => expect((h.flux as any).turn?.origin).toBe("user"));
      (h.flux as any).onWorkerOutput({ kind: "subagentStarted", id: "W0", description: "deploy-docs", type: "claude-worker", prompt: "Deploy docs.", background: true });
      await answer(h.flux, "開始部署 docs。", "user");
      h.conversations.receiveBotMention({ id: "R1", role: "bot", text: ASK, date: 0 }, h.caller);
      await vi.waitFor(() => expect((h.flux as any).turn?.callIn).toBe(BOTLING));
      (h.flux as any).onWorkerOutput({ kind: "subagentStarted", id: "W1", description: "deploy-botling-relay", type: "claude-worker", prompt: "Deploy the relay.", background: true });
      await answer(h.flux, "已經開始部署。");
      await vi.waitFor(() => expect(fromFlux(h.caller)).toHaveLength(1));
      (h.flux as any).workerReport("<app_task_result task_id=\"W0\">docs done</app_task_result>", "W0");
      await answer(h.flux, "docs 部署好了。", "app");
      h.flux.workerNote({ id: "W1", kind: "question", name: "deploy-botling-relay", message: "Which registry?", files: [] } as any, "<app_worker_note kind=\"question\">Which registry?</app_worker_note>");
      await answer(h.flux, "worker 問要用哪個 registry，請問要用 registry.driseam.com 嗎？", "app");
      await vi.waitFor(() => expect(fromFlux(h.caller)).toHaveLength(2));
      expect(fromFlux(h.caller)[1]).toContain("registry.driseam.com");
      expect(fromFlux(h.caller).join("\n")).not.toContain("docs");
      expect(h.woken).toHaveLength(2);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });
});
