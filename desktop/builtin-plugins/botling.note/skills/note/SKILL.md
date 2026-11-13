---
name: note
description: "The format of the user's Note for a bot (the Note tab, the file note.md: <project>/.bot/note.md): cells cut by <!-- cell --> / <!-- cell: id --> lines (the ids of note.db, read and changed with the app_note_* tools; a 問 quote starts with > 〔Note #id · Fork › Route〕), branches with <!-- branch: … --> / <!-- route: … --> / <!-- end branch --> markers, live <show> card lines, frozen card images, and what the whiteboard preview shows. Load it whenever you read, quote, summarize or write a Note or note.md, or meet those markers, instead of searching Botling's source."
---

# The Note (note.md)

Each bot has one Note: the Markdown file the **Note tab** edits. It is plain Markdown; a few whole-line HTML comments and `<show>` lines mean more than their text. This page is the whole format, so there is no need to search Botling's source for it.

## Where it is

| Bot | File |
|---|---|
| A project's bot | `<project>/.bot/note.md` |
| A sub bot | `<project>/.bot/sub-bots/<id>/note.md` |
| The main bot | `note.md` in its own folder |

Pictures sit beside it in `note-assets/` and are linked relatively: `![alt](note-assets/<hash>.png)`. The prompt names your note's exact path; use that one.

## Change it with the app_note_* tools

The app keeps each Note in a small database (`note.db`, next to `note.md`) where every cell has a fixed id, and writes `note.md` from it. Prefer the app's tools to editing the file:

| Tool | Does |
|---|---|
| `app_note_outline` | the Note as a tree: cells (`id`, `kind`, `rev`, first line) and branches with their routes |
| `app_note_read` | cells by `ids`, or all cells of a `route` (route id or `"Fork › Route"`), with their text and `rev` |
| `app_note_search` | find text in your Note (or `bot: "all"`: every Note of this project); each match names its cell id |
| `app_note_edit` | change one cell: the whole `text` with the `rev` you read, or `old_text` → `new_text` (unique in that cell) |
| `app_note_insert` | new cell(s) `after` / `before` a cell, or into a `route` (`at: "start"` / `"end"`); none = end of the note |
| `app_note_delete` | remove a cell |
| `app_note_move` | move a cell or a whole branch `after` / `before` a cell, or into a `route` |
| `app_note_split` / `app_note_merge` | cut a cell in two at a line / join it with the next cell of the same route |
| `app_note_branch` | `create` a branch (around cells or at a place), `add_route`, `rename`, `delete_route`, `dissolve` (keep one route), `delete` |

- Read first, then change with the `rev` you read; on a conflict the error carries the cell as it is now: read again and redo the change.
- The read tools also read the Notes of the other bots of your project (`bot`); you change only your own. Workers have only the read tools.
- A Note the app keeps as a plain file (file mode: the tools say so) has no ids: edit `note.md` directly, by the rules below.

### A 問 quote names its cell

When the user asks about a part of the Note from the Note tab (the 問 button), the chat gets a Markdown quote whose first line names the cell:

```
> 〔Note #b7k3f9 · Loading › Lazy load〕
> Load each tab's plugin only when the tab first opens.
```

`#b7k3f9` is the cell's id (for a quoted branch, the branch's id; the route named last is the one quoted), and `Loading › Lazy load` is where it is (fork › route, outermost first; nothing for the top of the note). Read the cell as it is now with `app_note_read {"ids":["b7k3f9"]}`, and change it by that id. A quote without that line (an older app, a Note in file mode) is just the text.

## Rules

- **Read it when it is relevant** (the user mentions the note, a plan or a route in it, or asks what is written there).
- **Edit it only when the user asks.** Never "tidy up" a note on your own.
- **Read the file right before you edit it**, then make the smallest edit: every line you were not asked to change stays **byte-identical**, including blank lines, spacing, table pipes and the final newline. The user may have the Note tab open; it reloads when the file changes on disk.
- **Prefer the `app_note_*` tools**; edit `note.md` directly only when they are not there or the Note is in file mode.
- **Never delete, reorder, rename or re-indent marker lines** (`<!-- cell -->` / `<!-- cell: id -->`, `<!-- branch: … -->`, `<!-- route: … -->`, `<!-- end branch -->`) unless the user asks for exactly that. A misplaced `route` or `end branch` silently moves text into another route.
- **Keep every `<!-- cell: id -->` line exactly as it is**, above the same text: never change, invent or copy an id. A cell you add by hand gets a plain `<!-- cell -->` line; the app gives it an id.
- Never write which route is "shown", collapse state, positions or any UI state into the file: that is not part of the format.
- Inside code fences (```` ``` ````) and `$$` math blocks, marker and `<show>` lines are plain text; they are drawn as code.

## Cells

A line on its own:

```
<!-- cell -->
```

cuts the note into cells (like notebook cells; each cell is a whole chunk of Markdown: headings, lists, paragraphs, a table, a code block). Branch, route and end-branch lines also bound cells.

The app writes the same line with the cell's id, `<!-- cell: b7k3f9 -->`, above every cell of a Note it keeps in `note.db` (the first cell and the first cell of each route too). Both forms are a cell line and cut the note the same way; the id says which cell of `note.db` the text below it is. When you edit `note.md` by hand:

- keep each `<!-- cell: id -->` line with the text below it: moving a cell means moving its id line with it; deleting a cell, deleting its id line with it;
- to add a cell, write a plain `<!-- cell -->` line (the old form, still valid everywhere) above the new text; never make up an id or write one twice;
- the Note tab shows no id lines and saves without them; the app keeps the ids by matching the cells' text. A note with no cell lines is fine: it is then one cell per region (the top, each route, the part after a branch). One blank line right next to a cell line is optional and takes no room; every other blank line shows as an empty line, so do not add or remove blank lines you were not asked to.

- To add a cell after some text: put `<!-- cell -->` on its own line after it, then the new text (or use `app_note_insert`).
- To add text to an existing cell: write it inside that cell, between its boundary lines.

## Branches and routes

A branch shows alternative versions of a part of the note (e.g. two approaches). The user sees one route at a time and switches between them in the Note tab.

```
<!-- branch: Loading -->
<!-- route: Lazy load -->
…lines of this route…
<!-- route: Prebuilt snapshot -->
…lines of this route…
<!-- end branch -->
```

- A `route` line starts a route of the **innermost branch still open**. The route's lines run until the next `route` line or `end branch` of that branch.
- `end branch` closes the innermost open branch. Text **outside** every branch (before it, and after its `end branch`) is **shared** by all routes.
- Branches nest: a branch inside a route belongs to that route, and it must be closed by its own `end branch` before the outer branch's next `route` or `end branch`.
- Write markers exactly like this: each on its own line, with no indentation, `<!-- branch: Name -->`, `<!-- route: Name -->`, `<!-- end branch -->`.
- **Always** give names. **Always** put the first `route` line directly under the `branch` line, and **always** close a branch with `end branch`. (Without that first `route`, lines between `branch` and it become an unnamed route in the editor; without `end branch`, the branch runs to the end of the file.)
- Route names should differ within one branch. The editor remembers the shown route and the collapse state per branch name and route name, so renaming one resets that memory.
- A `route` or `end branch` with no branch open is plain text.

### Common edits

- **Add text to one route:** insert it between that route's line and the next `route` / `end branch` line of the same branch (not after a nested branch's `end branch` unless you mean the route's own text below that nested branch).
- **Add text shared by every route:** put it outside the branch, before `<!-- branch: … -->` or after its `<!-- end branch -->`.
- **Add a new route:** insert `<!-- route: New name -->` and its lines just before the branch's `<!-- end branch -->` (or before another `route` line of the same branch to place it earlier).
- **Add a new branch:** wrap the alternatives in `<!-- branch: Name -->` + `<!-- route: A -->` … `<!-- route: B -->` … `<!-- end branch -->` at the place they belong. To turn existing text into the first route, put the `branch` and first `route` lines above it, and the second `route`, its lines and `end branch` below it; the existing text itself stays unchanged.
- **Nest a branch:** do the same inside a route, keeping the inner `end branch` above the outer branch's next `route` / `end branch`.

## Live cards

A `<show>` tag standing on its own line(s) is drawn as a live card, the same syntax as the chat's cards:

```
<show name="weather">{"city":"Taipei","temp":24}</show>
<show name="disk-usage" command="du -sh ~/Downloads" refresh="10m"></show>
<show name="build-status"></show>
```

- `name` is required: a component the bot can show in chat. The tag must start the line (no text before it on that line) and may span several lines.
- With JSON inside: the card shows that data. The JSON must be valid, or the line stays plain text.
- `command="…"` with an empty body: the card is filled by running that command in the bot's folder, only after the user allows it. With neither JSON nor command (`<show name="…"></show>` or `<show name="…"/>`), the component's own Command fills it.
- `refresh="10m"` (1 s to 1 h) reruns the command on that timer while the note is open.
- A card is a cell of its own even without `<!-- cell -->` lines around it.
- **Frozen card:** when the user freezes a card, the `<show>` line(s) are replaced in place by an image link `![name](note-assets/<hash>.png)`, a snapshot of the card. Where the card shared a cell with text, `<!-- cell -->` lines are added around the image so it stays a cell of its own. A frozen card is just a picture now. Do not turn it back into a `<show>` unless asked.

Images are ordinary Markdown images. Prefer relative `note-assets/…` links; an absolute path or `file://` image is copied into `note-assets/` by the Note tab and its link rewritten.

## Whiteboard preview

The Note tab has a **白板** button (top right; Esc returns). It draws the same file as a read-only flow from top to bottom:

- one card per cell;
- a branch splits into side-by-side columns, one per route, merging again at `end branch` (nested branches split again inside);
- live cards and images show a small preview or placeholder.

The user can zoom, pan, collapse a branch into a compact card listing its routes, double-click a card to jump to that cell, and click a route title to show that route. All of that (the shown route, which branches are collapsed, the zoom) lives in the Note tab's own view state, **never in note.md**, and nothing about positions is stored. So you never write anything for the whiteboard: a well-formed note (cells, branches with routes, cards) is all it needs.

## Examples

### 1. A plain note with cells

```markdown
# Cold-start plan

Cold start is 2.8 s today; target 1.5 s.

<!-- cell -->

## To do
- [x] List plugins loaded at startup
- [ ] Load the Board tab lazily

<!-- cell -->

| Machine | Cold start |
|---|---|
| M1 | 2.8 s |
```

### 2. A branch with two routes, plus shared text

```markdown
# Cold-start plan

Shared by both routes: measure on M1 and M3 first.

<!-- branch: Loading -->
<!-- route: Lazy load -->
Load each tab's plugin only when the tab first opens.
<!-- route: Prebuilt snapshot -->
Save a snapshot of the first screen and show it on the next start.
<!-- end branch -->

## Acceptance
Shared again: 5 runs per machine, trace attached.
```

To add a step to "Prebuilt snapshot" only, insert it on a new line just above `<!-- end branch -->`. To add a third route, insert `<!-- route: Smaller bundle -->` and its text there.

### 3. A nested branch with a card

```markdown
# Cold-start plan

<show name="weather">{"city":"Taipei","temp":24}</show>

<!-- branch: Loading -->
<!-- route: Lazy load -->
Load each tab's plugin when it first opens.
<!-- cell -->
<show name="startup-trace" command="node scripts/trace.js" refresh="1m"></show>
<!-- route: Prebuilt snapshot -->
Save a snapshot of the first screen.
<!-- branch: Where to keep it -->
<!-- route: Local cache -->
In Application Support, cleared on upgrade.
<!-- route: Ship with the app -->
Built at package time; the app grows a few MB.
<!-- end branch -->
After either choice: check the snapshot is fresh.
<!-- end branch -->

## Acceptance
- [ ] 5 runs per machine
```

Here "After either choice…" belongs to the route "Prebuilt snapshot" (below its nested branch), and "## Acceptance" is shared by all routes.
