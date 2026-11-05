import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error jsdom ships without .d.ts
import { JSDOM } from "jsdom";
// @ts-expect-error ESM helper without d.ts
import { loadReports, root } from "../../../reports/load.mjs";

describe("botling.report readability, retired native charts, kind-aware budgets, and disabled SVG", () => {
  let api: any;
  let temp: string;

  const base = {
    version: 2,
    lang: "zh-Hant",
    title: "EEG 可讀性測試",
    asOf: "2026-11-05",
    tldr: "你問 SESS 在跨人實驗是否縮水；答案是換算公平指標後兩資料集增益幾乎相等。",
  };

  beforeAll(async () => {
    api = await loadReports();
    temp = mkdtempSync(join(tmpdir(), "report-readability-"));
    mkdirSync(join(temp, "artifacts"), { recursive: true });
  });

  afterAll(() => {
    rmSync(temp, { recursive: true, force: true });
  });

  it("draws no native charts: a retired bar block shows its values as a plain table under a notice, with no SVG", async () => {
    const bar = await api.renderBlock({
      type: "bar",
      title: "扣除隨機猜測後，MAtt 跨人增益兩資料集相等，SPDIM 跨人轉負",
      unit: "Δκ",
      series: [{ name: "BCI-IV-2a" }, { name: "OpenBMI" }],
      rows: [
        { label: "MAtt 跨受試者", values: [0.098, 0.096] },
        { label: "SPDIM 跨受試者", values: [-0.032, -0.033] },
      ],
    }, { mode: "doc" });
    expect(bar.errors).toEqual([]);
    const d = new JSDOM(`<body>${bar.html}</body>`).window.document;
    expect(d.querySelector("svg")).toBeNull();
    expect(d.querySelector(".rt-note")?.textContent).toContain("Python");
    expect([...d.querySelectorAll("tbody tr")].map((r: any) => r.textContent)).toEqual(["MAtt 跨受試者0.098 Δκ0.096 Δκ", "SPDIM 跨受試者-0.032 Δκ-0.033 Δκ"]);

    const badStacked = api.registry.get("bar").schema.safeParse({
      type: "bar",
      stacked: true,
      series: [{ name: "A" }, { name: "B" }],
      rows: [{ label: "x", values: [3, -1] }],
    });
    expect(badStacked.success).toBe(false);
  });

  it("relaxes takeaway, prose, and 9-subject table budgets for research kinds while keeping status/plan concise", () => {
    const nineSubjects = Array.from({ length: 12 }, (_, i) => [`A0${i + 1}`, 74.5 + i * 0.2, 75.1 + i * 0.2]);
    const termExplanation = "先講白話定義：SESS 是在進模型前把每個人腦波的平均背景拉齊（像先把不同麥克風的底噪歸零）；Δκ 則是扣掉亂猜分數後的真實進步幅度，避免四選一（25%）與二選一（50%）直接相減造成錯覺。".repeat(5);
    const takeaway = "扣除隨機猜測基準並換算公平指標後，跨受試者增益在兩個資料集其實完全相等而非縮水";

    for (const kind of ["investigation", "explainer", "results", "comparison"] as const) {
      const blocks: any[] = [
        { type: "glossary", items: [{ term: "EEG", plain: "腦波。" }, { term: "SESS", plain: "把每個人的腦波背景先拉齊。" }, { term: "MAtt", plain: "一種腦波分類模型。" }, { term: "Δκ", plain: "扣掉亂猜後的進步幅度。" }] },
        { type: "prose", text: termExplanation },
        { type: "table", title: "全體受試者明細", columns: ["受試者", "無對齊", "加 SESS"], rows: nineSubjects },
      ];
      if (kind === "investigation") blocks.push({ type: "flowchart", title: "因果鏈", nodes: [{ id: "a", label: "設定" }, { id: "b", label: "結果" }], edges: [{ from: "a", to: "b" }] });
      if (kind === "results") blocks.push({ type: "kpi", items: [{ label: "MAtt Δκ", value: "0.098" }] });
      // The subject table is exact values: it sits in a collapsed section (a numeric table in the main part is warned).
      const { spec, errors } = api.validateSpec({ ...base, kind, impact: "跨人增益沒有縮水，SESS 值得繼續做。", asks: [], sections: [{ title: "實驗", takeaway, collapsed: true, blocks }] });
      expect(errors).toEqual([]);
      expect(api.lintSpec(spec, api.registry)).toEqual([]);
    }

    for (const kind of ["status", "plan"] as const) {
      const { spec, errors } = api.validateSpec({
        ...base,
        kind,
        asks: [],
        sections: [{ title: "進度", takeaway, blocks: [{ type: "prose", text: termExplanation }, { type: "table", columns: ["項", "A", "B"], rows: nineSubjects }] }],
      });
      expect(errors).toEqual([]);
      const messages = api.lintSpec(spec, api.registry).map((w: any) => w.message).join("\n");
      expect(messages).toContain("Takeaway is long");
      expect(messages).toContain("evidence too long");
      expect(messages).toContain("12 rows; keep ≤ 8");
    }
  });

  it("disables SVG images (local file via CLI and inline data URI): a warning, and the page shows the alt text instead", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><text x="10" y="15">標籤</text></svg>`;
    writeFileSync(join(temp, "chart.svg"), svg, "utf8");
    const specPath = join(temp, "spec.json");
    const outPath = join(temp, "artifacts", "svg-warn.html");
    const inline = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
    writeFileSync(specPath, JSON.stringify({
      ...base,
      kind: "explainer",
      asks: [],
      sections: [{
        title: "圖表",
        takeaway: "手刻 SVG 已停用，頁面只顯示替代文字",
        blocks: [{ type: "image", title: "手刻長條圖", alt: "測試用 SVG", src: "chart.svg" }, { type: "image", title: "內嵌", alt: "內嵌 SVG", src: inline }],
      }],
    }), "utf8");

    let stdout = "";
    const code = api.runCli([specPath, outPath, "--force"], { stdout: (t: string) => { stdout += t; }, stderr: () => {} });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    for (const at of [0, 1]) expect(parsed.warnings.some((w: any) => w.path === `sections[0].blocks[${at}].src` && w.message.includes("SVG images are disabled") && w.example?.type === "figure")).toBe(true);
    const page = new JSDOM(readFileSync(outPath, "utf8")).window.document;
    expect(page.querySelectorAll(".blk-image img").length).toBe(0);
    expect(page.querySelector(".blk-image .fg-none")?.textContent).toBe("測試用 SVG");
  });

  it("ships plain-language, chart reading-guide, and no-handcoded-SVG rules in report-blocks.md", () => {
    const shipped = readFileSync(join(root, "docs/report-blocks.md"), "utf8");
    expect(shipped).toBe(api.promptDoc());
    expect(shipped).toContain("Plain language before jargon");
    expect(shipped).toContain("One question per chart + one-sentence reading guide");
    expect(shipped).toContain("never hand-written SVG");
    expect(shipped).toContain("## Figures (matplotlib)");
    expect(shipped).toContain("Charts first, detail collapsed");
    expect(shipped).toContain("## Page template: charts first");
    expect(shipped).toContain("Template for flowcharts: `flowchart.py`");
  });
});
