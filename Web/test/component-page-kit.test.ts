import { describe, expect, it } from "vitest";
import { componentPage } from "../src/components";
import { kitV1 } from "../kit/generated/kit-v1";

// A template that asks for the kit (<meta name="ccb-kit" content="1">) gets it inline, right
// after the page's ccb runtime, and <html data-theme="dark">; nothing else on its page changes.

const template = `<meta name="ccb-kit" content="1"><div id="app"></div><script>ccb.kit.render(ccb.kit.html\`<p>hi</p>\`)</script>`;

describe("componentPage with the kit meta", () => {
  it("puts the kit into <head>, after the ccb runtime and before the template", () => {
    const page = componentPage(template, "{}");
    const runtime = page.indexOf("window.ccb = {");
    const kit = page.indexOf(kitV1);
    expect(runtime).toBeGreaterThan(-1);
    expect(kit).toBeGreaterThan(runtime);
    expect(kit).toBeLessThan(page.indexOf("</head>"));
    expect(page.indexOf("</head>")).toBeLessThan(page.indexOf(template));
    expect(page.split(kitV1)).toHaveLength(2);
    expect(page).toMatch(/^<!doctype html><html data-theme="dark" data-size="2x2" data-surface="chat">/);
  });

  it("is otherwise the page the same template gets without the kit", () => {
    type Rest = [Record<string, string>, "1x1" | "4x2", "board" | "pinned", boolean, boolean];
    const cases: Rest[] = [[{}, "1x1", "board", true, true], [{ a: "b" }, "4x2", "pinned", false, false]];
    for (const args of cases) {
      const kitPage = componentPage(template, `{"x":1}`, ...args);
      const plain = componentPage(template.replace(`<meta name="ccb-kit" content="1">`, `<meta name="ccb-kxx" content="1">`), `{"x":1}`, ...args);
      const back = kitPage.replace(`<script>\n${kitV1}\n</script>`, "").replace(` data-theme="dark"`, "").replace(`<meta name="ccb-kit" content="1">`, `<meta name="ccb-kxx" content="1">`);
      expect(back).toBe(plain);
    }
  });

  it("reads the meta however it is written: quotes, order, spacing, self-closing", () => {
    for (const meta of [`<meta name='ccb-kit' content='1'>`, `<meta content="1" name="ccb-kit" />`, `<META  name="ccb-kit"   content="1"/>`]) {
      expect(componentPage(`${meta}<p></p>`, "{}")).toContain(kitV1);
    }
  });

  it("says so in an error card when the template asks for a kit version this app does not have", () => {
    const page = componentPage(`<meta name="ccb-kit" content="7"><p></p>`, "{}");
    expect(page).not.toContain(kitV1);
    expect(page).toContain("ccb-kit");
    expect(page).toMatch(/kit version 7/);
  });

  it("only looks at the template's own meta, not the words in a script or text", () => {
    const page = componentPage(`<p>write &lt;meta name="ccb-kit"&gt;</p><script>const s = 'ccb-kit'</script>`, "{}");
    expect(page).not.toContain(kitV1);
    expect(page).not.toContain("data-theme");
  });
});
