import { describe, expect, it } from "vitest";
import { componentPage } from "../src/components";

// Templates without <meta name="ccb-kit" ...> get the page they got before the kit existed, byte
// for byte: nothing injected, no data-theme. The snapshot file was written from componentPage as
// it was before Web/kit (branch bot/task-sidebar-r23-20261026) and must not be regenerated.
const legacy: [string, Parameters<typeof componentPage>][] = [
  ["plain chat card", [`<div class="card">Hello</div><script>document.querySelector('.card').textContent = ccb.data.text</script>`, `{"text":"hi"}`]],
  ["board tile, fill, saving, pictures", [`<style>.x{color:red}</style><img src="">`, `{"a":1}`, { "/tmp/a.png": "botling-card://image/1" }, "1x1", "board", true, true]],
  ["pinned 4x2", [`<p>pinned</p>`, `null`, {}, "4x2", "pinned"]],
  ["other meta tags and the words ccb-kit in text", [`<meta name="viewport" content="width=device-width"><meta name="ccb-kit-ish" content="1"><p>uses ccb-kit later</p>`, `{"x":"</script>"}`, {}, "2x1", "chat", false, false]],
];

describe("componentPage without the kit meta", () => {
  for (const [name, args] of legacy) {
    it(`is unchanged: ${name}`, async () => {
      await expect(componentPage(...args)).toMatchFileSnapshot(`./fixtures/component-page-legacy/${name.replace(/[^a-z0-9]+/gi, "-")}.html`);
    });
  }
});
