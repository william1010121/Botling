# Reusable React reports

> **v2 (block system).** New reports use ReportSpec v2 (`"version": 2`): sections of composable blocks (charts, flowcharts, KPIs, matrices, timelines…) chosen per report, rendered as a document or as 16:9 slides from the same JSON. The bot-facing catalog, report-kind skeletons and budgets are in [`report-blocks.md`](report-blocks.md) (generated). Code: `desktop/reports/v2/` — `blocks/` (one file per block, `defineBlock` with Zod schema + description + examples + Doc/Slide component), `spec.ts` (ReportSpec + per-block validation → ErrorBlock), `planner.ts` (pure row and slide planners), `lint.ts` (handbook budgets), `theme/` (Botling tokens, light + dark), `examples/` (four Traditional Chinese examples). `node desktop/scripts/report.mjs spec.json out.html [--slides]` prints `{ok, errors, warnings, htmlPath, link}`; `--check` validates only; `--docs` regenerates `report-blocks.md` and `reports/v2/report-spec.schema.json`. The app ships the same command (`reports/cli.ts` → `out/report/report.cjs`, run as `Botling --render-report …`, which needs no Node) and the guide outside app.asar (`Resources/report/report-blocks.md`); core passes both to every bot's instructions (`desktopPrompts` → `reportPageLine`, after the results rule; BOTLING_REPORT_COMMAND / BOTLING_REPORT_DOCS from main). Screenshots: `node desktop/reports/shots.mjs /abs/out` (headless shell, no windows). Tests: `npm run test:reports`. v1 specs below keep rendering unchanged (version dispatch in `reports/render.tsx`).

Reports are **versioned structured content rendered by shared React components**, delivered as a single offline HTML artifact. Use this workflow for future reports instead of copying HTML/CSS from a previous report. This is separate from Maintainer's in-chat component library.

## Generate and preview

From the repository root, using the existing linked desktop dependencies:

```sh
node desktop/scripts/report.mjs desktop/reports/examples/project-status-20261028.json /absolute/workspace/.bot/artifacts/project-status.html
# Alternatively, from desktop/: npm run report -- input.json /absolute/workspace/.bot/artifacts/report.html
```

The destination directory must already exist within an `artifacts` directory. Existing files are not overwritten unless `--force` is supplied. Validation happens before writing. The command prints a ready-to-use `[title](file:///absolute/path/artifacts/report.html)` link. Put that link in the bot response: existing `page-preview.ts` discovers it, `cardData` supplies a versioned URL, and main serves it through `botling-card://preview`. No app restart, dev server or new preview handler is needed. The older Swift app's equivalent route is `ccb-preview://page`; compatibility there is structural, not a new runtime validation claim.

Minimal input:

```json
{
  "schemaVersion": 1,
  "lang": "zh-Hant",
  "title": "專案狀態",
  "asOf": "2026-10-28 · 已核對的證據時間",
  "summary": "先寫最重要的結論與下一個決策。"
}
```

Required: `schemaVersion`, `title`, `asOf`, `summary`. `lang` defaults to `en` (also `zh-Hant`). Optional: `subtitle`, `sections`, `evidence`, `nextSteps`, `limitations`; empty optional groups disappear. `asOf` is a human-readable evidence timestamp, not an automatically asserted freshness guarantee.

Each section has a `title` and nonempty `blocks`:

- `paragraph`: `{ "type": "paragraph", "text": "Plain text" }`
- `list`: `{ "type": "list", "items": ["One", "Two"], "ordered": true }`
- `table`: `{ "type": "table", "caption": "Results", "columns": ["Check", "Result"], "rows": [["Preview", "Passed"]] }`
- `finding`: `{ "type": "finding", "title": "Delivery", "status": "unverified", "evidence": "What was observed", "next": "Smallest next action" }`

Finding statuses: `complete`, `partial`, `pending`, `blocked`, `unverified`. Status is supplied explicitly; the framework does not infer delivery from source completion. Evidence entries are `{ "source": "path or reference", "detail": "What it establishes" }`; next steps and limitations are arrays of strings. All strings are **plain text**, escaped by React (Markdown and raw HTML are not interpreted). Unknown fields, blank required text, unsupported versions and mismatched table row lengths fail validation. No arbitrary CSS, scripts, images or remote resource URLs are accepted as rendering instructions in v1. Source URLs can be cited as plain text; interactive links/media can be a separately reviewed schema extension.

## Architecture and choice

Local inspection found React 19.3.0, React DOM 19.3.0, Zod 4.6.7 and esbuild 0.28.2 already locked in `desktop/package.json`; there is no dedicated report package in that manifest. Nothing in the request identifies a specific npm library or PDF product. Reuse these dependencies rather than adding a UI suite, PDF renderer or another templating language. No lockfile/dependency changes are required.

`reports/schema.ts` is the content contract; `Report.tsx` owns accessible report components; `report.css` owns typography/layout tokens; `render.tsx` calls React DOM's `renderToStaticMarkup`. `scripts/report.mjs` bundles **only the generator** into a temporary CommonJS module and cleans it up after rendering. Output begins exactly `<!doctype html><meta charset="utf-8">`, contains inline CSS and complete content, and has no JavaScript/runtime, CDN, font download, hydration or development-server dependency. React is used to author/render every report, not shipped needlessly to read it.

The existing preview response applies `PREVIEW_CSP` including `sandbox allow-scripts`; the containing component uses `COMPONENT_CSP`, allowing a preview iframe only through the registered origin. Report HTML needs neither scripts nor privileged APIs, so no permissions, generated bot rules or CSP changes are necessary. This integrates at the existing file artifact contract; it does not silently change every agent's generation instructions or install a runtime report tool. Future authors invoke the documented command.

## Consistent format

The header, evidence date and summary are essential. Findings, tables, evidence, limitations and next steps are optional according to the report's purpose. One h1, ordered heading levels, named sections, text status labels, table captions/column headers and keyboard-scrollable tables make the hierarchy usable without relying on color.

System fonts avoid network/font licensing dependencies. Shared spacing (primarily 8px multiples), restrained 1040px content width, 16px text and 1.65 line height support reading. Findings show evidence before the next action. Small screens stack status labels and scroll wide tables without scrolling the entire page. Light/dark follows the reader's system preference. Print CSS uses light ink, repeats table headers and avoids splitting small findings; very tall blocks necessarily paginate. Browser print/PDF works where the host exposes it; this feature adds no app print button or PDF-export API.

The example preserves the original 2026-10-28 audit's seven findings and labels the version/install evidence as historical. It does not claim the old installed version is current, or turn historical tests into new execution evidence.

## Focused validation

```sh
node --test desktop/reports/report.test.mjs
./desktop/node_modules/.bin/tsc -p desktop/reports/tsconfig.json
node desktop/reports/preview-check.mjs /absolute/workspace/.bot/artifacts/report.html /absolute/workspace/.bot/artifacts/react-report-validation
```

The last command is an explicit **seven-finding audit-example** visual check, not a generic report validator. It launches a hidden isolated Electron harness (no app profile, install or restart), importing the production `previewFile`, `previewResponse`, and `COMPONENT_CSP`. It exercises direct preview and sandboxed iframe routes, light/dark/narrow layouts, no horizontal page overflow, image decode (vacuous for this image-free example), no network subresources, and Chromium print generation. Screenshots must still be inspected. This proves the production-serving contract in Electron, not the currently installed app's link-click UX, Swift WKWebView, or native Windows/Linux acceptance. The installed-app preview flow is unchanged.

Do not use the full app build/test/package scripts for report-only edits. Extend this schema and its focused behavior tests for new blocks rather than hand-writing per-report markup. Report source and JSON example are committed; generated user artifacts remain local under `.bot/artifacts`.
