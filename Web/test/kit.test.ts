/// <reference types="node" />
import { afterEach, describe, expect, it } from "vitest";
import { componentPage } from "../src/components";

// The component kit (Web/kit): Preact + hooks + htm and the ccb- blocks, put into a component's
// page when its template says <meta name="ccb-kit" content="1">. These run whole pages, scripts
// and all, in a window of their own, as the card's iframe does.

type FrameWindow = Window & typeof globalThis & { ccb: Record<string, unknown> & { kit: Kit } };
type Kit = Record<string, unknown> & { version: string };
const open: { close(): void }[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const kitMeta = `<meta name="ccb-kit" content="1">`;
async function page(template: string, data: unknown = {}, size: Parameters<typeof componentPage>[3] = "2x2", surface: Parameters<typeof componentPage>[4] = "chat") {
  const { JSDOM } = (await import("jsdom" as string)) as { JSDOM: new (html: string, options: object) => { window: FrameWindow } };
  const posted: Record<string, unknown>[] = [];
  const errors: unknown[] = [];
  const dom = new JSDOM(componentPage(template, JSON.stringify(data), {}, size, surface), {
    runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(win: FrameWindow) {
      (win as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} disconnect() {} };
      win.addEventListener("message", (event: MessageEvent) => { if (event.data?.ccb) posted.push(event.data); });
      win.addEventListener("error", (event: ErrorEvent) => errors.push(event.error ?? event.message));
    },
  });
  open.push(dom.window);
  const win = dom.window;
  const settle = () => new Promise((resolve) => win.setTimeout(resolve, 30));
  await settle();
  const send = async (message: unknown) => { win.dispatchEvent(new win.MessageEvent("message", { data: message, source: win })); await settle(); };
  return { win, doc: win.document, posted, errors, settle, send };
}
const app = (body: string) => `${kitMeta}<div id="app"></div><script>
const { html, render, useData, useSize, useSurface, Card, Stat, Ring, Bar, Spark, List, Chips, Button, Choices, Empty } = ccb.kit;
${body}
</script>`;

describe("the kit in a component page", () => {
  it("gives the template ccb.kit: html, render, the hooks and the ten blocks", async () => {
    const { win } = await page(app(""));
    const kit = win.ccb.kit;
    expect(kit.version).toMatch(/^1\.\d+\.\d+$/);
    for (const name of ["h", "html", "render", "Fragment", "Component", "useState", "useEffect", "useMemo", "useRef", "useCallback", "useReducer", "useContext", "createContext", "useData", "useSize", "useSurface",
      "Card", "Stat", "Ring", "Bar", "Spark", "List", "Chips", "Button", "Choices", "Empty", "ErrorCard", "toneFor"]) {
      expect(kit[name], name).toBeTypeOf("function");
    }
    expect(win.document.documentElement.dataset.theme).toBe("dark");
    // Its stylesheet (tokens first, then the blocks) is in the head, before the template's own styles.
    const style = win.document.head.querySelector("style[data-ccb-kit]")!;
    expect(style.textContent).toMatch(/--ground:\s*#0E0E10/);
    expect(style.textContent).toContain(".ccb-card");
    expect(style.textContent).toMatch(/:root\[data-theme=("?)light\1\]/);
  });

  it("draws the blocks with ccb- classes, tones and sizes", async () => {
    const { doc } = await page(app(`
render(html\`<\${Card} title="CPU" icon="⚙" tone="warn">
  <\${Stat} label="Memory" value="12" unit="GB" delta=\${-3} tone="ok" size="l" />
  <\${Ring} value=\${82} max=\${100} label="82%" tone="bad" />
  <\${Bar} value=\${30} max=\${60} label="Disk" />
  <\${Bar} items=\${[10, 70, 90]} tone="auto" />
  <\${Spark} values=\${[1, 3, 2, 5]} />
  <\${List} items=\${[{ title: "node", detail: "pid 1", value: "40%" }, { title: "git", value: "2%" }]} />
  <\${Chips} items=\${["a", { label: "b", tone: "bad" }]} />
  <\${Button} tone="primary" icon="↻">Restart</\${Button}>
  <\${Empty} title="Nothing yet" detail="Run it once" />
</\${Card}>\`, document.getElementById("app"));`));
    const card = doc.querySelector(".ccb-card")!;
    expect(card.classList.contains("ccb-tone-warn")).toBe(true);
    expect(card.querySelector(".ccb-card__title")!.textContent).toContain("CPU");
    expect(card.querySelector(".ccb-card__icon")!.textContent).toBe("⚙");
    const stat = doc.querySelector(".ccb-stat")!;
    expect([...stat.classList]).toEqual(expect.arrayContaining(["ccb-tone-ok", "ccb-size-l"]));
    expect(stat.querySelector(".ccb-stat__value")!.textContent).toBe("12GB");
    expect(stat.querySelector(".ccb-stat__delta")!.classList.contains("ccb-down")).toBe(true);
    const ring = doc.querySelector(".ccb-ring")!;
    expect(ring.getAttribute("role")).toBe("meter");
    expect(ring.getAttribute("aria-valuenow")).toBe("82");
    expect(ring.querySelector(".ccb-ring__label")!.textContent).toBe("82%");
    const meter = doc.querySelector(".ccb-bar:not(.ccb-bar--columns) .ccb-bar__fill") as HTMLElement;
    expect(meter.style.width).toBe("50%");
    const columns = [...doc.querySelectorAll(".ccb-bar--columns .ccb-bar__col")];
    expect(columns.map((c) => [...c.classList].find((n) => n.startsWith("ccb-tone-")))).toEqual(["ccb-tone-ok", "ccb-tone-warn", "ccb-tone-bad"]);
    expect(doc.querySelector(".ccb-spark polyline")!.getAttribute("points")).toBeTruthy();
    expect(doc.querySelectorAll(".ccb-list__row")).toHaveLength(2);
    expect(doc.querySelectorAll(".ccb-chip")).toHaveLength(2);
    expect(doc.querySelector(".ccb-chip.ccb-tone-bad")).not.toBeNull();
    const button = doc.querySelector("button.ccb-button")!;
    expect(button.classList.contains("ccb-button--primary")).toBe(true);
    expect(button.textContent).toContain("Restart");
    expect(doc.querySelector(".ccb-empty__title")!.textContent).toBe("Nothing yet");
  });

  it("redraws with new data (useData) and a new size (useSize), and knows its surface", async () => {
    const { doc, send } = await page(app(`
function Cpu() {
  const d = useData();
  const size = useSize();
  return html\`<p id="out">\${d.cpu} \${size.name} \${size.w}x\${size.h} \${useSurface()}</p>\`;
}
render(html\`<\${Cpu} />\`, document.getElementById("app"));`), { cpu: 10 }, "1x1", "board");
    expect(doc.getElementById("out")!.textContent).toBe("10 small 1x1 board");
    await send({ ccbData: JSON.stringify({ cpu: 55 }) });
    expect(doc.getElementById("out")!.textContent).toBe("55 small 1x1 board");
    await send({ ccbSize: { w: 2, h: 1, name: "wide" } });
    expect(doc.getElementById("out")!.textContent).toBe("55 wide 2x1 board");
  });

  it("gives {} for no data, so d.field never throws", async () => {
    const { doc } = await page(app(`render(html\`<p id="out">\${String(useData.length >= 0)}</p>\`, document.getElementById("app"));
function Show() { const d = useData(); return html\`<i id="v">\${typeof d}:\${Object.keys(d).length}</i>\`; }
render(html\`<\${Show} />\`, document.getElementById("app"));`), null);
    expect(doc.getElementById("v")!.textContent).toBe("object:0");
  });

  it("shows an error card, and the pin's status, when a component throws", async () => {
    const { doc, posted } = await page(app(`
function Broken() { const d = useData(); return html\`<b>\${d.missing.deep}</b>\`; }
render(html\`<\${Card} title="ok"><\${Broken} /></\${Card}>\`, document.getElementById("app"));`));
    const error = doc.querySelector(".ccb-error")!;
    expect(error).not.toBeNull();
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toMatch(/deep/);
    expect(posted).toContainEqual(expect.objectContaining({ ccb: "status", tone: "bad" }));
  });

  it("shows an error card for malformed markup: an unclosed tag, a mismatched close, <Card> without ${}", async () => {
    for (const [markup, said] of [
      ["html`<${Card} title=\"x\"><b>hi</b>`", /never closed|not closed/i],
      ["html`<div><span>a</div>`", /<\/div>.*<span>|span/i],
      ["html`<Card title=\"x\">a</Card>`", /<\$\{Card\}>/],
      ["html`<div title=\"abc>x</div>`", /quote|unterminated|unfinished/i],
    ] as const) {
      const { doc, posted } = await page(app(`render(${markup}, document.getElementById("app"));`));
      const error = doc.querySelector(".ccb-error");
      expect(error, markup).not.toBeNull();
      expect(error!.textContent, markup).toMatch(said);
      expect(posted, markup).toContainEqual(expect.objectContaining({ ccb: "status", tone: "bad" }));
    }
  });

  it("lets well-formed markup through: self-closing, <//>, attributes with > in quotes, comments", async () => {
    const { doc } = await page(app(`render(html\`<div id="a" title="1 > 0"><!-- note --><br /><\${Card} title="x">in<//><input value=\${"v"} /></div>\`, document.getElementById("app"));`));
    expect(doc.querySelector(".ccb-error")).toBeNull();
    expect(doc.getElementById("a")!.getAttribute("title")).toBe("1 > 0");
    expect(doc.querySelector("#a .ccb-card")!.textContent).toContain("in");
  });

  it("Choices answers with the option's index or the typed text, then locks", async () => {
    const { doc, posted, settle } = await page(app(`
render(html\`<\${Choices} options=\${["Plan A", { label: "Plan B", description: "safer" }]} other="Something else" />\`, document.getElementById("app"));`));
    const options = [...doc.querySelectorAll("button.ccb-choice")] as HTMLButtonElement[];
    expect(options).toHaveLength(2);
    expect(options[1].querySelector(".ccb-choice__detail")!.textContent).toBe("safer");
    options[1].click();
    await settle();
    expect(posted).toContainEqual({ ccb: "answer", index: 1 });
    expect((doc.querySelector("button.ccb-choice") as HTMLButtonElement).disabled).toBe(true);
    expect(doc.querySelector(".ccb-choice.is-chosen")!.textContent).toContain("Plan B");

    const second = await page(app(`render(html\`<\${Choices} options=\${["A"]} other />\`, document.getElementById("app"));`));
    const input = second.doc.querySelector("input.ccb-choices__input") as HTMLInputElement;
    input.value = "my own";
    input.dispatchEvent(new second.win.Event("input", { bubbles: true }));
    await second.settle();
    (second.doc.querySelector(".ccb-choices__send") as HTMLButtonElement).click();
    await second.settle();
    expect(second.posted).toContainEqual({ ccb: "answer", text: "my own" });
  });

  it("Choices shows an answer given before (chosen / answer) as locked", async () => {
    const { doc } = await page(app(`render(html\`<\${Choices} options=\${["A", "B"]} chosen=\${0} />\`, document.getElementById("app"));`));
    expect(doc.querySelector(".ccb-choice.is-chosen")!.textContent).toContain("A");
    expect([...doc.querySelectorAll("button.ccb-choice")].every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe("the example to copy (Web/kit/examples/system-load)", () => {
  it("draws without an error at each size, from its about.md's data", async () => {
    const { readFileSync } = await import("node:fs");
    const dir = `${__dirname}/../kit/examples/system-load`;
    const template = readFileSync(`${dir}/template.html`, "utf8");
    const about = readFileSync(`${dir}/about.md`, "utf8");
    const data = JSON.parse(about.match(/```json\n([\s\S]*?)```/)![1]);
    for (const size of ["1x1", "2x1", "2x2", "4x2"] as const) {
      const { doc, posted } = await page(template, data, size, "board");
      expect(doc.querySelector(".ccb-error"), size).toBeNull();
      expect(doc.querySelector(".ccb-ring"), size).not.toBeNull();
      expect(posted, size).toContainEqual({ ccb: "status", text: "CPU 72%", tone: "warning" });
      expect(!!doc.querySelector(".ccb-list"), size).toBe(size === "2x2" || size === "4x2");
    }
    const empty = await page(template, {}, "2x2", "board");
    expect(empty.doc.querySelector(".ccb-empty__title")!.textContent).toBe("No reading yet");
  });
});
