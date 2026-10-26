# Component kit v1

Ready-made blocks for component templates (`template.html` in the plugin library), drawn exactly like
the app: same colours (the app's design tokens), same fonts, radii and controls. A card built from
them is a few dozen lines and needs no stylesheet of its own.

The kit is **Preact 10 + hooks + htm**: React's way of writing components (function components,
`useState`, `useEffect`, …) with tagged-template markup instead of JSX, so a template needs no build
step. It is not React itself: React packages (Recharts, MUI, …) do not work, and there is no
network to load them from anyway.

## Turning it on

Put this meta tag anywhere in `template.html` (first line is customary):

```html
<meta name="ccb-kit" content="1">
```

The app then puts the kit's script (about 47 KB, no network) into the page's `<head>`, right after
the `ccb` runtime and before the template, and marks the page `<html data-theme="dark">`. The kit
adds its stylesheet at the top of `<head>`, so the template's own `<style>` wins over it. Without the
meta tag nothing changes: the page is exactly what it was before the kit. The frame's sandbox and
CSP are the same either way (no network, no storage).

`content` is the kit's major version. A version the app does not have shows an error card. Version
1 only ever changes compatibly; a breaking change will be version 2, with 1 kept beside it.

## A whole template

```html
<meta name="ccb-kit" content="1">
<div id="app"></div>
<script>
const { html, render, useData, useSize, toneFor, Card, Stat, Ring, Bar, Button } = ccb.kit;

function Cpu() {
  const d = useData();               // ccb.data, redrawn on every new data
  const size = useSize();            // {w, h, name, px}
  if (size.w === 1) return html`<${Ring} value=${d.cpu} tone="auto" caption="CPU" />`;
  return html`<${Card} title="CPU" icon="⚙">
    <div class="ccb-row">
      <${Ring} value=${d.cpu} tone="auto" caption="CPU" />
      <${Stat} label="Memory" value=${d.mem} unit="GB" tone=${toneFor(d.mem, { max: 32 })} />
    </div>
    <${Bar} items=${d.cores || []} tone="auto" />
    <${Button} tone="primary" onClick=${() => ccb.answer("restart")}>Restart</${Button}>
  </${Card}>`;
}

render(html`<${Cpu} />`, document.getElementById("app"));
</script>
```

A complete, responsive example to copy: [`examples/system-load/`](examples/system-load/)
(`template.html` and its `about.md`). Its shots at 1×1, 2×1 and 2×2 are in
`.bot/artifacts/component-kit/systemload-*.png`.

## Writing markup with `html`

- Components go in `${}`: `<${Card} title="x">…</${Card}>`. Close with `</${Card}>` or `<//>`.
- Every tag closes: `<br />`, `<img src=${url} />`, `<input … />` (htm has no void tags).
- Values: `value=${n}`, `onClick=${fn}`, `class="…"` (not `className`), `style=${{ width: "50%" }}` or
  `style="…"`. Text in `${}` is escaped; there is no raw HTML insertion.
- Lists: `${items.map((item) => html`<li key=${item.id}>${item.name}</li>`)}`.
- Nothing to show: `${cond && html`…`}` (`false`/`null` draw nothing).

`html` checks each template before drawing it. An unclosed tag, a close that does not match
(`<div><span></div>`), `<Card>` written without `${}`, an attribute quote never closed, or an
unfinished tag throws a `MarkupError` that names the problem and quotes the template.

## Errors

- `render()` draws inside an error boundary: a component that throws while drawing is replaced by
  the error card (title, the error's message, a hint).
- An uncaught error or rejected promise anywhere in the template's scripts (including a malformed
  `html` at the top level) shows the error card at the top of the page.
- Either way the kit logs it (`console.error`) and calls `ccb.setStatus({ text: "Error", tone: "bad" })`,
  so a pinned card's chip shows it too.
- `showError(error)` shows the card yourself; `<${ErrorCard} error=${e} />` draws it as a block.

## API: `ccb.kit` (also `window.ccbKit`)

| Name | What |
| --- | --- |
| `html` | htm bound to Preact's `h`, checked (above). |
| `render(vnode, container?)` | Draws into `container` (default `#app`, else `#ccb-root`), with the error boundary. Call again to redraw with new props. |
| `h`, `Fragment`, `Component`, `createContext`, `createRef`, `cloneElement`, `toChildArray` | Preact. |
| `useState`, `useEffect`, `useLayoutEffect`, `useMemo`, `useRef`, `useCallback`, `useReducer`, `useContext`, `useId`, `useErrorBoundary` | Preact hooks. |
| `useData()` | The card's data (`ccb.data`), and the new data whenever it comes (`ccb.onData`: its command ran again, a pin refreshed, the bot updated it). The frame is kept and the component redraws. `{}` when there is none, so `d.cpu` never throws (`d.list.map` still does: write `(d.list \|\| [])`). |
| `useSize()` | `ccb.size`, kept up to date: `{w, h, name, px: {width, height}}`; `w`×`h` cells from 1×1 to 4×4, `name` "small", "wide", "tall", "large" or "xlarge". |
| `useSurface()` | "chat", "board" or "pinned". |
| `toneFor(value, {max = 100, warn = 0.6, bad = 0.85, invert = false})` | "ok" under 60 % of max, "warn" under 85 %, else "bad" (`invert`: low is bad). "neutral" for no number. |
| `showError(error)`, `ErrorCard` | See Errors. |
| `version` | "1.0.0". |

Everything else of `ccb` (`ccb.answer`, `ccb.save`, `ccb.setStatus`, `ccb.runDetail`, `ccb.open`,
`ccb.image`, `ccb.pickImage`, …) is unchanged; call it directly.

## Blocks

Every block takes, besides its own props:

- `tone`: "ok" (green), "warn" (orange), "bad" (red), "info" (blue), "neutral" (grey). Also accepted:
  "good", "warning", "error", "danger", "success", "accent", "muted". Blocks that show a number also
  take `tone="auto"` (`toneFor(value, {max})`).
- `size`: "s", "m" (default) or "l".  `compact`: tighter spacing.  `icon`: a short text or emoji.
- `class`, `style`, `id`, `title`, `aria-*`, … go onto its outer element.

| Block | Props | Draws |
| --- | --- | --- |
| `Card` | `title`, `subtitle`, `icon`, `actions` (vnode, right of the title), `footer`, `framed`, children | The card: header, body, footer. No frame of its own (the bubble or Board tile frames it; on the Board it is at least the tile's height). `framed`: a bordered box, for cards inside a card. |
| `Stat` | `label`, `value`, `unit`, `delta` (number, or text like "+3%"), `invert` (a fall is good), `detail`, `framed`, `max` (for `tone="auto"`) | One figure. `tone` colours the value; the delta is ▲/▼, green when good, red when bad. |
| `Ring` | `value`, `max` (100), `label` (centre; the percent when absent), `caption` (under it), `thickness` (10 of 100), `size` ("s" 56, "m" 84, "l" 120 px, or a number of px) | A round gauge, `role="meter"`. |
| `Bar` | One meter: `value`, `max`, `label`, `unit` or `valueText`. Rows: `items` of `{label, value, max?, tone?, valueText?}`. Columns: `items` of numbers (or `columns`), `height` px. | Meters, or a small column chart. `max` defaults to 100 when every value is 0–100, else the largest. |
| `Spark` | `values`, `min`, `max`, `height` (40 px), `fill` (true), `dot` (true), `label` (for screen readers) | A sparkline with a soft area and a dot on the last value. |
| `List` | `items` of `{title (or label), detail, value, icon, tone, onClick, key}`, `max` (then "+N more"), `empty` (text when none), `more` ("more") | Rows; one with `onClick` is a button. |
| `Chips` | `items` of text or `{label, tone, icon, active}`, `onPick(item, index)` | Small pills; a tone adds a dot. With `onPick` they are buttons. |
| `Button` | `tone` "default", "primary", "danger", "ghost" (others colour the text), `size`, `icon`, `full`, `disabled`, `onClick`, `type` | The app's 32 px button (26 px "s", 40 px "l"). |
| `Choices` | `options` (text or `{label, description}`), `other` (true or its placeholder: adds a typed answer), `chosen` (index), `answer` (text), `onPick(i, option)`, `onOther(text)`, `sendLabel`, `answeredLabel`, `disabled` | The choices card: picking answers `ccb.answer(i)` (the index), sending the field answers `ccb.answer(text)`; then it locks. `chosen`/`answer` show an earlier answer locked. `onPick`/`onOther` replace the answering. |
| `Empty` | `icon`, `title`, `detail`, `action` (a Button), children | The "nothing here" state. |

Layout helpers (plain classes): `ccb-row` (a wrapping row), `ccb-stack` (a column), `ccb-grid`
(as many columns of at least `--ccb-min`, 110 px, as fit), `ccb-spacer` (pushes what follows
right), `ccb-label` (a small grey heading), `ccb-muted`. Visibility: `ccb-hide-narrow` /
`ccb-only-narrow` (frame under 240 px wide, about one Board cell), `ccb-hide-short` (a Board tile
under 180 px tall, one row).

## Sizes and responsiveness

- `<html data-size="2x1">` (the cells) and `#ccb-root`, a container named `ccb`, are the hooks.
  The blocks already shrink at one cell wide (smaller padding, figures and icons; list details and
  choice descriptions hidden) and one row tall (fewer list rows, tighter choices, no card footer).
- For your own layout: `@container ccb (max-width: 239px) { … }`, `html[data-size="1x1"] .x { … }`, or
  `useSize()` when the structure itself changes (e.g. only a Ring at 1×1, as in the example).
- Content taller than a Board tile scrolls inside it (the scrollbar is hidden): put the important
  part first.

## Colours and customising

- Tokens (from `Web/src/tokens.css`, the same file the app shell and the chat use): `--ground`,
  `--bubble`, `--line`, `--border`, `--raised`, `--chip`, `--hover`, `--selected`, `--text`,
  `--muted`, `--faint`, `--blue`, `--link`, `--green`, `--orange`, `--orange-text`, `--error`,
  `--code`, `--claude`, `--codex`. Use them in the template's own CSS: `color: var(--muted)`.
- Dark is what the app draws now; `[data-theme="light"]` has the light set, so a template that uses
  tokens (and no fixed colours) is ready for both. Do not write `prefers-color-scheme` rules.
- Override per block or anything around it: `--accent` (fills: ring arc, bars, sparkline, primary
  button, icon tint; wins over `tone`), `--ink` (the big value's text). Also `--ccb-ring-size`,
  `--ccb-bars-h`, `--ccb-spark-h`, `--ccb-min`, `--ccb-gap`, `--ccb-pad`, `--ccb-control-h`.
  Example: `<${Ring} value=${v} style="--accent:#F2A64A" />`.
- Or restyle a class in the template's `<style>` (it comes after the kit's): `.ccb-stat__value {
  font-size: 40px }`. All kit classes start with `ccb-`; keep your own classes without that prefix.

## Porting an existing component (for the Maintainer)

1. Add `<meta name="ccb-kit" content="1">` and `<div id="app"></div>`; delete the template's colour
   variables, `prefers-color-scheme` block and the `.card` frame rules (Card does that).
2. Turn the DOM-building script into one function component that reads `useData()` (and `useSize()`
   where the layout changes by size); end with `render(html`<${Name} />`, document.getElementById("app"))`.
3. Map pieces: a big number → `Stat`; percent bar → `Bar`; gauge → `Ring`; process/file rows →
   `List`; tags/badges → `Chips`; buttons → `Button`; choices + "Other" → `Choices`; "No data yet" → `Empty`.
   Keep thresholds with `toneFor(v, {warn, bad})` or `tone="auto"`.
4. `setStatus` goes in a `useEffect` on the value it shows. A template that used `ccb.onData` gets it
   from `useData()` for free (do not also call `ccb.onData`).
5. Keep the data format and `about.md` the same, so saved cards and pins keep drawing. Check 1×1,
   2×1 and 2×2 with a Component shot.

## Building the kit (app source)

`Web/kit/src` (blocks, hooks, the markup check, `kit.css`) and `Web/kit/vendor` (Preact 10.29.8 and
hooks, MIT; htm 3.1.1, Apache-2.0; their licences beside them) are bundled by `node Web/kit/build.mjs`
into `dist/kit.v1.js` and `dist/kit-v1.ts` (the same text as a string for `Web/src/components.ts`).
Both are committed; `Web/build.mjs` rebuilds them, and `Web/test/kit-build.test.ts` fails when they
are stale. Tests: `Web/test/kit.test.ts`, `component-page-kit.test.ts`, `component-page-legacy.test.ts`.
