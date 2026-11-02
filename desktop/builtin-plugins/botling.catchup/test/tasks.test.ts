// @vitest-environment jsdom
// Task cards in a summary (moved from Web/test/task-cards.test.ts): the task's chip beside the bullet
// about it with the header's count, and "Jump to chat" landing on the bullet of a folded reply.
import { beforeAll, describe, expect, it } from "vitest";
import { sent } from "../../../../Web/src/bridge";
import type { ChatState, MessageView, TaskCardView } from "../../../../Web/src/types";
import { citedBullet } from "../src/sources";
import type { CatchUpView } from "../src/types";
import { openPage, withSummaries } from "./page";

// jsdom has no CSS.escape; the ids here need none.
globalThis.CSS ??= { escape: (value: string) => value } as unknown as typeof CSS;

const taskID = "5E1D7A2C-1111-4222-8333-944455556666";
const card = (extra: Partial<TaskCardView> = {}): TaskCardView => ({ id: taskID, name: "Fix the board", state: "running", owner: "claude", ...extra });
const line = (id: string, role: MessageView["role"] = "bot", extra: Partial<MessageView> = {}): MessageView => ({
  id, role, text: `text ${id}`, stamp: null, avatar: null, choices: null, chosen: null, answer: null, open: false,
  attachments: null, replyTo: null, replyPreview: null, openable: false, ...extra,
});

describe("task markers in a summary's bullets", () => {
  it("are taken out of the words and kept as the task's id", () => {
    const source = [line("m1")];
    expect(citedBullet(`Board fixed. [[task:${taskID.toLowerCase()}]] [[source:m1]]`, source)).toEqual({
      text: "Board fixed.", sources: [{ messageID: "m1" }], tasks: [taskID],
    });
    expect(citedBullet("No task here [[source:m1]]", source)).toEqual({ text: "No task here", sources: [{ messageID: "m1" }] });
  });
});

describe("the summary card", () => {
  const view = (extra: Partial<CatchUpView> = {}): CatchUpView => ({
    key: "task-k", ids: ["b", "c"], count: 2, state: "ready", model: "gpt-test", since: "23:51", until: "00:22",
    bullets: [`Board counts main now. [[task:${taskID}]] [[source:b]]`, "Codex stopped editing in parallel. [[source:c]]"],
    tasks: [card({ state: "done" }), card({ id: "6F2E8B3D-2222-4333-8444-A55566667777", name: "Cross-platform", state: "waiting" })],
    ...extra,
  });
  const state = (catchUp: CatchUpView): ChatState => withSummaries({
    botID: "task-bot", botName: "botling", working: false, avatar: "face", placeholder: "", replyingTo: null, pendingFiles: [], components: {},
    messages: [line("a", "user"), line("b", "bot", { taskCards: [card({ state: "done" })] }), line("c")], catchUp,
  });

  beforeAll(openPage);

  it("puts the task's chip beside the bullet about it, before the source chips, and counts the tasks", () => {
    window.ccb.setState(state(view()));
    const bullets = [...document.querySelectorAll(".catchup-bullets li")];
    const first = bullets[0];
    const chips = [...first.querySelectorAll("button")];
    expect(chips[0].classList.contains("task-card-chip")).toBe(true);
    expect(chips[0].classList.contains("done")).toBe(true);
    expect(chips[1].classList.contains("source-cite")).toBe(true);
    expect(first.textContent).not.toContain("[[task:");
    expect(bullets[1].querySelector(".task-card-chip")).toBeNull();
    expect(document.querySelector(".catchup-meta")?.textContent).toBe("2 unread · 2 tasks");
    expect(document.querySelector(".catchup-task-count")?.classList.contains("waiting")).toBe(true);
  });

  it("opens the task when its chip there is pressed, not the originals", () => {
    window.ccb.setState(state(view()));
    document.querySelector<HTMLButtonElement>(".catchup-bullets .task-card-chip")!.click();
    expect(sent.at(-1)).toEqual({ type: "selectTask", id: taskID });
    expect(document.querySelector(".summary-source-viewer")).toBeNull();
  });

  it("jumps to the bullet of a task whose reply is folded, and flashes it", () => {
    window.ccb.setState(state(view()));
    expect(document.querySelector('.row[data-id="b"]')?.classList.contains("decoration-folded")).toBe(true);
    window.ccb.jumpToTask("b", taskID);
    const bullet = document.querySelector(".catchup-bullets li")!;
    expect(bullet.classList.contains("flash")).toBe(true);
    expect(document.querySelector('.row[data-id="b"]')?.classList.contains("decoration-folded")).toBe(true);
  });

  it("has no count when no task has lines in the range", () => {
    window.ccb.setState(state(view({ key: "task-k2", tasks: null })));
    expect(document.querySelector(".catchup-meta")?.textContent).toBe("2 unread");
    expect(document.querySelector(".catchup-task-count")).toBeNull();
  });
});
