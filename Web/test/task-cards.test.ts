import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sent } from "../src/bridge";
import { messageElement } from "../src/messages";
import { citedBullet } from "../src/summary-sources";
import type { CatchUpView, ChatState, MessageView, TaskCardView } from "../src/types";

// Task cards in the chat: the chip under a reply of a task, the same chip beside a summary's
// bullet with the header's count, and "Jump to chat" landing on the summary that folds a reply.

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
// jsdom has no CSS.escape; the ids here need none.
globalThis.CSS ??= { escape: (value: string) => value } as unknown as typeof CSS;

const taskID = "5E1D7A2C-1111-4222-8333-944455556666";
const card = (extra: Partial<TaskCardView> = {}): TaskCardView => ({ id: taskID, name: "Fix the board", state: "running", owner: "claude", ...extra });
const line = (id: string, role: MessageView["role"] = "bot", extra: Partial<MessageView> = {}): MessageView => ({
  id, role, text: `text ${id}`, stamp: null, avatar: null, choices: null, chosen: null, answer: null, open: false,
  attachments: null, replyTo: null, replyPreview: null, openable: false, ...extra,
});

describe("the chip under a reply", () => {
  it("comes first in the footer, in its state's color, with how the task stands on the latest reply", () => {
    const row = messageElement(line("r1", "bot", { reactionEnabled: true, taskCards: [card({ detail: "Now: drawing card 2" })] }), {});
    const footer = row.querySelector(".message-footer")!;
    expect(footer.firstElementChild?.className).toBe("task-card-chips");
    const chip = footer.querySelector<HTMLButtonElement>(".task-card-chip")!;
    expect(chip.classList.contains("running")).toBe(true);
    expect(chip.dataset.taskId).toBe(taskID);
    expect(chip.querySelector(".task-card-mark")?.textContent).toBe("●");
    expect(chip.querySelector(".task-card-name")?.textContent).toBe("Fix the board · Now: drawing card 2");
    expect(chip.getAttribute("aria-label")).toBe("Task Fix the board: Running");
    expect(chip.closest(".bubble")).toBeNull();
  });

  it("shows each state and the open task, and stands alone without other footer parts", () => {
    const states: TaskCardView["state"][] = ["pending", "waiting", "done", "stopped", "stale"];
    const row = messageElement(line("r2", "bot", { taskCards: states.map((state, index) => card({ id: `t${index}`, state, selected: state === "waiting" })) }), {});
    const chips = [...row.querySelectorAll<HTMLElement>(".task-card-chip")];
    expect(chips.map((chip) => chip.querySelector(".task-card-mark")?.textContent)).toEqual(["○", "◐", "✓", "■", "!"]);
    expect(chips.map((chip) => [...chip.classList].filter((name) => name !== "task-card-chip"))).toEqual([["pending"], ["waiting", "selected"], ["done"], ["stopped"], ["stale"]]);
    expect(chips[1].getAttribute("aria-pressed")).toBe("true");
    expect(row.querySelectorAll(".message-footer > *")).toHaveLength(1);
  });

  it("opens its task in the right panel when pressed", () => {
    const row = messageElement(line("r3", "bot", { taskCards: [card()] }), {});
    row.querySelector<HTMLButtonElement>(".task-card-chip")!.click();
    expect(sent.at(-1)).toEqual({ type: "selectTask", id: taskID });
  });

  it("keeps a task name as text, never markup", () => {
    const row = messageElement(line("r4", "bot", { taskCards: [card({ name: "<img src=x onerror=alert(1)>" })] }), {});
    expect(row.querySelector(".task-card-chip img")).toBeNull();
    expect(row.querySelector(".task-card-name")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("is styled like the background-work pills: 20px high, 11px words, radius 10", () => {
    const css = readFileSync(`${__dirname}/../src/chat.css`, "utf8");
    const rule = css.split(".task-card-chip {")[1]?.split("}")[0] ?? "";
    expect(rule).toMatch(/height: 20px/);
    expect(rule).toMatch(/font-size: 11px/);
    expect(rule).toMatch(/border-radius: 10px/);
  });
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
  const state = (catchUp: CatchUpView): ChatState => ({
    botID: "task-bot", botName: "botling", working: false, avatar: "face", placeholder: "", replyingTo: null, pendingFiles: [], components: {},
    messages: [line("a", "user"), line("b", "bot", { taskCards: [card({ state: "done" })] }), line("c")], catchUp,
  });

  beforeAll(async () => {
    document.body.innerHTML = `<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>`;
    await import("../src/main");
  });

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
    expect(document.querySelector('.row[data-id="b"]')?.classList.contains("catchup-folded")).toBe(true);
    window.ccb.jumpToTask("b", taskID);
    const bullet = document.querySelector(".catchup-bullets li")!;
    expect(bullet.classList.contains("flash")).toBe(true);
    expect(document.querySelector('.row[data-id="b"]')?.classList.contains("catchup-folded")).toBe(true);
  });

  it("has no count when no task has lines in the range", () => {
    window.ccb.setState(state(view({ key: "task-k2", tasks: null })));
    expect(document.querySelector(".catchup-meta")?.textContent).toBe("2 unread");
    expect(document.querySelector(".catchup-task-count")).toBeNull();
  });
});
