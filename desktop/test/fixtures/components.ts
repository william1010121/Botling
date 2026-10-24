// A small component library for tests, in 2.0's layout (<core>/plugins/ccb-components/components/):
// a status card, a todo list that keeps its state (ccb.save) and sets its pin chip (ccb.setStatus),
// and a card whose data comes from a command, with a Detail command (ccb.runDetail).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LIBRARY: Record<string, { template: string; about: string }> = {
  status: {
    template: `<div class="card" id="status">Status: <b id="ok"></b></div>
<script>document.getElementById('ok').textContent = ccb.data && ccb.data.ok ? 'OK' : 'not OK';</script>`,
    about: `Status card: one line saying whether something is OK.
Data: {"ok": true}
Sizes: 2x1, 2x2
Icon: 📊`,
  },
  todo: {
    template: `<div class="card"><ul id="items"></ul><button id="add" style="min-height:44px">Add one</button><button id="done" style="min-height:44px">Done</button></div>
<script>
const list = document.getElementById('items');
let items = (ccb.data && ccb.data.items) || [];
const draw = () => { list.innerHTML = ''; for (const item of items) { const li = document.createElement('li'); li.textContent = item; list.append(li); } ccb.setStatus({ text: items.length + ' open', tone: 'good' }); };
draw();
document.getElementById('add').onclick = () => { items = [...items, 'item ' + (items.length + 1)]; draw(); ccb.save({ items }); };
document.getElementById('done').onclick = () => ccb.answer('All done: ' + items.join(', '));
</script>`,
    about: `Todo list: a list the user can add to; it keeps its items.
Data: {"items": ["buy milk"]}
When the user presses Done, the bot gets "All done: …".`,
  },
  gitlog: {
    template: `<div class="card"><div id="count"></div><button id="more" style="min-height:44px">More</button><div id="detail"></div></div>
<script>
document.getElementById('count').textContent = 'Commits: ' + (ccb.data ? ccb.data.n : '?');
document.getElementById('more').onclick = () => ccb.runDetail({ hash: 'abc123' }).then((value) => { document.getElementById('detail').textContent = 'Detail: ' + value; }, (error) => { document.getElementById('detail').textContent = 'Error: ' + error.message; });
</script>`,
    about: `Git log card: how many commits there are; More shows one commit.
Command: printf '{"n":3}'
Detail command: printf 'detail-%s' {hash}`,
  },
};

/** Writes the library into a core data folder (the core's own, `<data>` or `<data>/core` in the app). */
export function writeLibrary(coreDir: string, names: string[] = Object.keys(LIBRARY)) {
  for (const name of names) {
    const folder = join(coreDir, "plugins", "ccb-components", "components", name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "template.html"), LIBRARY[name]!.template);
    writeFileSync(join(folder, "about.md"), LIBRARY[name]!.about);
  }
}
