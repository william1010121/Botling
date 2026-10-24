import { beforeAll, describe, expect, it } from "vitest";
import type { CatchUpView, ChatState, MessageView } from "../src/types";
import { sent } from "../src/bridge";
import { bulletHTML } from "../src/catchup";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const line = (id: string, role: MessageView["role"] = "bot"): MessageView => ({
  id, role, text: `text ${id}`, stamp: null, avatar: role === "bot" ? `face-${id}` : null, choices: null,
  chosen: null, answer: null, open: false, attachments: null, replyTo: null, replyPreview: null, openable: false,
});
const view = (extra: Partial<CatchUpView> = {}): CatchUpView => ({
  key: "k1", ids: ["b", "c", "d", "e"], count: 4, heads: 2, state: "ready",
  bullets: ["Build passed for 51db02f0", "!! Ship before the gap is known?"], model: "gpt-test",
  since: "18:04", until: "18:36", latest: "Claude: Ship now?", ...extra,
});
const state = (catchUp: CatchUpView | null, extra: Partial<ChatState> = {}): ChatState => ({
  botID: "catchup-bot", botName: "Garden", messages: ["a", "b", "c", "d", "e"].map((id) => line(id, id === "a" ? "user" : "bot")),
  working: false, avatar: "face", placeholder: "", replyingTo: null, pendingFiles: [], components: {}, catchUp, ...extra,
});
const rows = () => [...document.querySelectorAll<HTMLElement>("#messages > .row")];
const order = () => [...document.querySelectorAll<HTMLElement>("#messages > *")].map((el) =>
  el.classList.contains("catchup-head") ? "HEAD" : el.classList.contains("catchup-end") ? "END" : el.dataset.id ?? "?");

beforeAll(async () => {
  document.body.innerHTML = `<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>`;
  await import("../src/main");
});

describe("catch-up summary", () => {
  it("folds the unread rows behind a card placed before the first, without moving them", () => {
    window.ccb.setState(state(view()));
    const before = rows();
    expect(order()).toEqual(["a", "HEAD", "b", "c", "d", "e"]);
    expect(before.filter((row) => row.classList.contains("catchup-folded")).map((row) => row.dataset.id)).toEqual(["b", "c", "d", "e"]);
    const card = document.querySelector(".catchup-card")!;
    expect(card.getAttribute("aria-label")).toBe("Catch-up summary");
    expect(document.querySelector(".catchup-divider")?.textContent).toBe("4 unread · since 18:04");
    expect(card.querySelector(".catchup-meta")?.textContent).toBe("4 unread · 2 heads");
    expect(card.querySelector(".catchup-range")?.textContent).toBe("18:04 – 18:36");
    expect(card.querySelectorAll(".catchup-bullets li")).toHaveLength(2);
    expect(card.querySelector(".catchup-bullets code")?.textContent).toBe("51db02f0");
    expect(card.querySelector("li.decision strong")?.textContent).toBe("Waiting for your decision:");
    expect(card.querySelector(".catchup-latest")?.textContent).toBe("Latest · Claude: Ship now?");
    expect(card.querySelector(".catchup-by")?.textContent).toBe("Summary by gpt-test · may leave out details");
    expect(card.querySelectorAll(".catchup-faces img")).toHaveLength(3);

    // A later update keeps the same row elements in place.
    window.ccb.setState(state(view(), { working: false }));
    expect(rows()).toEqual(before);
    expect(order()).toEqual(["a", "HEAD", "b", "c", "d", "e"]);
  });

  it("expands to every message with an end row, and collapses again", () => {
    window.ccb.setState(state(view()));
    const toggle = document.querySelector<HTMLButtonElement>('[data-action="toggle"]')!;
    expect(toggle.textContent).toBe("Show 4 messages");
    toggle.click();
    expect(document.querySelectorAll(".catchup-folded")).toHaveLength(0);
    expect(order()).toEqual(["a", "HEAD", "b", "c", "d", "e", "END"]);
    expect(document.querySelector('[data-action="toggle"]')?.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".catchup-latest")?.textContent).toBe("Showing all 4 unread below");
    expect(document.querySelector(".catchup-end span")?.textContent).toBe("End of unread · you’re caught up");
    document.querySelector<HTMLButtonElement>('[data-action="collapse"]')!.click();
    expect(document.querySelectorAll(".catchup-folded")).toHaveLength(4);
    expect(order()).toEqual(["a", "HEAD", "b", "c", "d", "e"]);
  });

  it("shows loading with the selected model, and a failure with Retry", () => {
    window.ccb.setState(state(view({ key: "k2", state: "loading", bullets: [] })));
    expect(document.querySelector(".catchup-writing")?.textContent).toBe("Writing summary with gpt-test…");
    expect(document.querySelector(".catchup-by")).toBeNull();
    window.ccb.setState(state(view({ key: "k2", state: "failed", bullets: [], error: "The model timed out after 60 s." })));
    expect(document.querySelector(".catchup-error-title")?.textContent).toBe("Couldn’t write a summary");
    expect(document.querySelector(".catchup-error-detail")?.textContent).toBe("The model timed out after 60 s. Nothing was lost — all 4 messages are below.");
    document.querySelector<HTMLButtonElement>('[data-action="retry"]')!.click();
    expect(sent.at(-1)).toEqual({ type: "catchUpRetry", botID: "catchup-bot" });
  });

  it("removes the group and unfolds when there is none", () => {
    window.ccb.setState(state(view()));
    window.ccb.setState(state(null));
    expect(document.querySelector(".catchup-head")).toBeNull();
    expect(document.querySelectorAll(".catchup-folded")).toHaveLength(0);
    expect(order()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("escapes bullets and only marks hex ids that look like ids", () => {
    expect(bulletHTML("<b>x</b> `code` deadbeef 1234567 abc1234")).toBe(
      "<li><span class=\"dot\" aria-hidden=\"true\"></span><span>&lt;b&gt;x&lt;/b&gt; <code>code</code> deadbeef 1234567 <code>abc1234</code></span></li>");
  });
});

it("preserves all mixed source targets beyond model limits in loading/ready/failed cards and opens them", async () => {
  const { sourceLinks } = await import("../src/catchup-links");
  const source = line("b");
  source.text = `${"long prose ".repeat(1500)}
[Report](<file:///tmp/final report.html>) [Alternate report](<file:///tmp/final report.html>)
[Site](https://example.org/a_(b)?x=1&y=2) <https://example.org/auto>
![Image](file:///tmp/picture.png) ![Video](file:///tmp/movie.mp4)
[Reference][ref] Bare: https://example.org/plain.
\`file:///tmp/code.pdf\`

[ref]: https://example.org/reference "Reference title"

[Unsafe](javascript:alert%281%29)
`;
  source.attachments = [{ name: "Attached", url: "file:///tmp/attached.zip", kind: "file" }];
  source.artifacts = [{ title: "Artifact", url: "https://claude.ai/public/artifacts/abc", host: "claude.ai" }];
  const expected = ["file:///tmp/final%20report.html", "https://example.org/a_(b)?x=1&y=2", "https://example.org/auto", "file:///tmp/picture.png", "file:///tmp/movie.mp4", "https://example.org/reference", "https://example.org/plain", "file:///tmp/code.pdf", "javascript:alert%281%29", "file:///tmp/attached.zip", "https://claude.ai/public/artifacts/abc"];
  expect(sourceLinks([source]).map((link) => link.url)).toEqual(expected);
  expect(sourceLinks([source])[0].labels).toEqual(["Report", "Alternate report"]);
  for (const phase of ["loading", "ready", "failed"] as const) {
    window.ccb.setState(state(view({ state: phase, bullets: ["Model omitted every reference"] }), { messages: [line("a"), source, line("c"), line("d"), line("e")] }));
    const links = [...document.querySelectorAll<HTMLAnchorElement>(".catchup-links a")];
    expect(links.map((link) => link.dataset.url)).toEqual(expected.filter((url) => !url.startsWith("javascript:")));
    expect(links[0].textContent).toBe("Report · Alternate report");
    expect(document.querySelector(".catchup-links")?.textContent).toContain("Unsafe");
    expect(document.querySelector(".catchup-links script")).toBeNull();
  }
  document.querySelector<HTMLAnchorElement>('.catchup-links [data-url="file:///tmp/final%20report.html"]')!.click();
  expect(sent.at(-1)).toEqual({ type: "openURL", url: "file:///tmp/final%20report.html", label: "Report · Alternate report" });
});

it("offers a manual trigger without a group, disables it for empty/loading and hides it for subagents", () => {
  const button = () => document.querySelector<HTMLButtonElement>(".composer-tools .catchup-button")!;
  window.ccb.setState(state(null));
  expect(button().textContent).toBe("Summarize");
  expect(button().title).toContain("latest 20 replies");
  button().click();
  expect(sent.at(-1)).toEqual({ type: "catchUpManual", botID: "catchup-bot" });
  window.ccb.setState(state(null, { messages: [] }));
  expect(button().disabled).toBe(true);
  expect(button().textContent).toBe("No messages to summarize");
  window.ccb.setState(state(view({ state: "loading", manual: true })));
  expect(button().disabled).toBe(true);
  expect(button().textContent).toBe("Summarizing…");
  expect(document.querySelector(".catchup-divider")?.textContent).toBe("Summary · 4 messages");
  window.ccb.setState(state(null, { subagent: { id: "x" } as ChatState["subagent"] }));
  expect(button().hidden).toBe(true);
});


it("deduplicates only equal targets and preserves literal punctuation and escaped captions", async () => {
  const { sourceLinks } = await import("../src/catchup-links");
  const source = line("literal");
  source.text = '[A & B](https://example.org/a?q=1#one) [Other](https://example.org/a?q=1#two) [Again](https://example.org/a?q=1#one) `file:///tmp/report.`';
  expect(sourceLinks([source])).toEqual([
    { url: "https://example.org/a?q=1#one", labels: ["A & B", "Again"] },
    { url: "https://example.org/a?q=1#two", labels: ["Other"] },
    { url: "file:///tmp/report.", labels: [] },
  ]);
});
