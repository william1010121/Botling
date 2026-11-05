import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error jsdom ships without .d.ts
import { JSDOM } from "jsdom";
// @ts-expect-error ESM helper without d.ts
import { loadReports, root } from "../../../reports/load.mjs";

describe("botling.report readability, diverging bars, kind-aware budgets, and SVG hygiene", () => {
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

  it("renders native horizontal and vertical diverging bars with 0-baseline, exact 3-decimal labels, and optional referenceLine", async () => {
    const horiz = await api.renderBlock({
      type: "bar",
      title: "扣除隨機猜測後，MAtt 跨人增益兩資料集相等，SPDIM 跨人轉負",
      unit: "Δκ",
      series: [{ name: "BCI-IV-2a" }, { name: "OpenBMI" }],
      rows: [
        { label: "MAtt 跨受試者", values: [0.098, 0.096] },
        { label: "MF 跨受試者", values: [0.136, 0.037] },
        { label: "SPDIM 跨受試者", values: [-0.032, -0.033] },
      ],
    }, { mode: "doc" });
    expect(horiz.errors).toEqual([]);
    const hd = new JSDOM(`<body>${horiz.html}</body>`).window.document;
    expect(hd.querySelector(".hb.div")).toBeTruthy();
    expect(hd.querySelectorAll(".hz").length).toBe(3);
    expect(hd.querySelector(".hx span.z")?.textContent).toBe("0");
    const valuesText = [...hd.querySelectorAll(".hr:not(.ha) .hv")].map((el: any) => el.textContent);
    expect(valuesText).toEqual(["+0.098 Δκ · +0.096", "+0.136 Δκ · +0.037", "-0.032 Δκ · -0.033"]);

    const vert = await api.renderBlock({
      type: "bar",
      title: "單一資料集加減 SESS 的準確率變化",
      horizontal: false,
      unit: "pp",
      series: [{ name: "增益" }],
      rows: [
        { label: "MAtt", values: [7.3] },
        { label: "MF", values: [10.2] },
        { label: "SPDIM", values: [-2.4] },
      ],
    }, { mode: "doc" });
    expect(vert.errors).toEqual([]);
    const vd = new JSDOM(`<body>${vert.html}</body>`).window.document;
    expect(vd.querySelector(".vb.div")).toBeTruthy();
    expect(vd.querySelector(".zl")).toBeTruthy();
    expect(vd.querySelector(".vs.neg em")?.textContent).toBe("-2.4");

    const posWithRef = await api.renderBlock({
      type: "bar",
      title: "2a 跨受試者準確率均高於 25% 隨機猜測線",
      horizontal: false,
      unit: "%",
      referenceLine: { value: 25, label: "隨機猜測 25%" },
      series: [{ name: "無 SESS" }, { name: "加 SESS" }],
      rows: [
        { label: "MAtt", values: [41.7, 49.0] },
        { label: "SPDIM", values: [52.6, 50.2] },
      ],
    }, { mode: "doc" });
    expect(posWithRef.errors).toEqual([]);
    const pd = new JSDOM(`<body>${posWithRef.html}</body>`).window.document;
    expect(pd.querySelector(".vb:not(.div)")).toBeTruthy();
    expect(pd.querySelector(".brl em")?.textContent).toBe("隨機猜測 25%");

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
        { type: "prose", text: termExplanation },
        { type: "table", title: "全體受試者明細", columns: ["受試者", "無對齊", "加 SESS"], rows: nineSubjects },
      ];
      if (kind === "investigation") blocks.push({ type: "flowchart", title: "因果鏈", nodes: [{ id: "a", label: "設定" }, { id: "b", label: "結果" }], edges: [{ from: "a", to: "b" }] });
      if (kind === "results") blocks.push({ type: "kpi", items: [{ label: "MAtt Δκ", value: "0.098" }] });
      const { spec, errors } = api.validateSpec({ ...base, kind, asks: [], sections: [{ title: "實驗", takeaway, blocks }] });
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

  it("warns on dense <text> hand-coded SVG images (local file via CLI and inline data URI) without blocking render", () => {
    const denseSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">${Array.from({ length: 12 }, (_, i) => `<text x="10" y="${15 * (i + 1)}">標籤${i}</text>`).join("")}</svg>`;
    const svgPath = join(temp, "dense-chart.svg");
    const specPath = join(temp, "spec.json");
    const outPath = join(temp, "artifacts", "svg-warn.html");
    writeFileSync(svgPath, denseSvg, "utf8");
    writeFileSync(specPath, JSON.stringify({
      ...base,
      kind: "explainer",
      asks: [],
      sections: [{
        title: "圖表",
        takeaway: "手刻 SVG 字數過多時應發出非阻斷警告",
        blocks: [{ type: "image", title: "手刻長條圖", alt: "測試密集文字 SVG", src: "dense-chart.svg" }],
      }],
    }), "utf8");

    let stdout = "";
    const code = api.runCli([specPath, outPath, "--force"], { stdout: (t: string) => { stdout += t; }, stderr: () => {} });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.warnings.some((w: any) => w.path === "sections[0].blocks[0].src" && w.message.includes("12 <text> elements"))).toBe(true);
  });

  it("ships plain-language, chart reading-guide, and no-handcoded-SVG rules in report-blocks.md", () => {
    const shipped = readFileSync(join(root, "docs/report-blocks.md"), "utf8");
    expect(shipped).toBe(api.promptDoc());
    expect(shipped).toContain("Plain language before jargon");
    expect(shipped).toContain("One question per chart + one-sentence reading guide");
    expect(shipped).toContain("Never hand-code data-chart SVGs");
  });
});
