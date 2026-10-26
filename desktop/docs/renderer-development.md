# Updating the renderer without restarting Botling 2

Use the existing esbuild pipeline with a renderer-only watcher. No Vite server, new dependencies,
HTTP origin, HMR injection or CSP changes are needed. The watcher publishes compiled JS, HTML, CSS,
design tokens, character images and KaTeX assets to the selected output (default `desktop/out/renderer`).
It never deletes `out/`
or rebuilds main, core, preloads or the plugin host. Wait for `[renderer] ready`, then press Cmd+R
(Ctrl+R on Windows/Linux) in the app. Builds with syntax/missing-input errors leave the previous
successful output available. Files publish by atomic rename; wait for ready before reloading to
avoid mixing files during publication. The watcher polls source metadata every 300 ms and also
handles atomic editor saves/new source directories.

## Source development workflow

Use the chosen worktree (not the shared dirty checkout):

```sh
sh desktop/scripts/link-deps.sh
cd desktop
npm run build              # one initial shell/main/core/preload build, or after main/core changes
npm run renderer:watch -- --outdir="$PWD/out/renderer" # keep running; no app launch/restart
```

In a second terminal, start an independently authorized development instance once:

```sh
cd /absolute/path/to/worktree/desktop
npm start
```

Then edit shell sources, wait for the ready line, and press Cmd+R. The native chat editor is
preserved by the existing app-menu fix (`553eeb8`); Reload and Force Reload still target the shell
webContents, never the focused native editor. Core processes and active agent work keep running.
Shell-local transient state can reset on reload. Source development data continues to use that worktree's
`.data`; do not point an independent source instance at a running installed app's data directory.

## Reloading the native chat page and the preloads

The chat page and composer (Web/src's page plus `src/renderer/chat-frame`, served as
`botling-chat://chat/chat.html`, `chat.js`, `chat.css`, `frame.css` from the same renderer directory)
now reload on their own, without restarting the app:

- **View → Reload Chat Page** (Alt+Cmd+R / Alt+Ctrl+R) reloads the focused window's native chat page.
- **IPC:** the shell (or an install/update card) sends the main-only contract command
  `{ type: "chat.reloadPage" }` and gets `{ reloaded: boolean }` (`false` when that window has no
  native chat host, it was closed, or the new page failed to load).

Main reloads the existing native `WebContentsView` in place (`reloadNativeEditor` in
`src/main/editor-host.ts`): the view, its bounds and the window layout stay; the shell receives
`unbound` and then `bound` with a fresh document generation, so messages to or from the old document
are refused. On `bound` the shell pushes the current chat state and plugins again, so the page
rehydrates from the core (chat state never lived in the page). Only main can start this navigation;
any other main-frame navigation of the editor still disposes it, and a page that fails to load
disposes the view instead of leaving a dead one bound. Shell Cmd+R (`553eeb8`) is unchanged: it
still reloads only the shell and keeps the chat page.

What survives a chat page reload:

- The chat, its rows, cards, tasks and running agent work (core utility process; untouched).
- **Unsent drafts**, per chat: the page mirrors the composer's `draft` actions into its own tab's
  `sessionStorage` and saves the box being typed in on `pagehide` (so the composer's 500 ms save
  delay cannot lose the last words), then hands them to `Composer.setDrafts` in the new document
  (`src/renderer/chat-frame/draft-keep.ts`). This storage lives only as long as that web contents:
  drafts are still not kept across an app restart.
- Not kept: page-local UI state such as scroll position, an open popover/menu in the chat page, the
  composer's undo history and an IME composition in progress.

**Preloads** run again whenever their page reloads. `npm run preload:build` rebuilds only
`out/preload/preload.cjs` and `out/preload/editor-host.cjs` (atomic publish; a failed build keeps the
last good files; never clears `out/`). Then Cmd+R picks up the shell preload and Reload Chat Page the
chat page's. A source run reads them from `desktop/out/preload`; a dev-trial artifact can take them
from a developer build with `--botling-preload-dir=/absolute/dir` (built with
`npm run preload:build -- --outdir=/absolute/dir`), gated exactly like `--botling-renderer-dir`
(source runs and `botlingDevTrial` artifacts only; absolute; both files present; ordinary packaged
builds ignore it). A preload change that also changes main's side of a channel still needs a restart.

For occasional source-instance updates, `npm run renderer:build -- --outdir="$PWD/out/renderer"` builds just the renderer once. For a separate asset
directory, either renderer command accepts `-- --outdir=/absolute/path/to/renderer-output`.
`node build.mjs --watch` now directs callers to `renderer:watch` instead of implying the full build
watches source changes.

## Normal installed developer-trial use: persistent explicit opt-in

The renderer directory can be explicitly configured once, independently of launch arguments,
installed app location and source worktree. Use a stable output directory **outside** disposable
worktrees; on the authorized development disk, the recommended path is:

```sh
cd /absolute/path/to/integrated-checkout/desktop
npm run renderer:build -- --outdir=/Volumes/My-SSD/botling-work/renderer-live
npm run renderer:configure -- --enable --outdir=/Volumes/My-SSD/botling-work/renderer-live
npm run renderer:watch
```

These commands build renderer assets and save an explicit local opt-in. They do not install,
launch or restart the app. `renderer:watch` and `renderer:build` without `--outdir` thereafter use
that configured stable output. An explicit `--outdir` overrides the command's output destination;
it does not change the persisted configuration. Without configuration, commands still default to
this checkout's `out/renderer`.

After an approved deployment of this loader and an initial ordinary launch, a developer trial
reads the configured output automatically. Finder launches and the existing installer/relaunch
need no additional arguments. Subsequent compatible shell edits: keep the watcher running, wait
for `[renderer] ready`, then Cmd+R. Stopping the watcher or deleting its source worktree does not
delete the stable output. Resume watching from a current integrated checkout when changing sources.
Use sources compatible with the installed trial's main/core/preload contracts, particularly after
an app update; a persisted opt-in intentionally continues to select that output across updates.
No worktree scanning or automatic choice of an arbitrary checkout is performed.

Configuration is versioned JSON with `version: 1`, `enabled: true`, and the absolute `directory`.
It lives at the platform app-data root plus
`Botling 2 Dev Trial/renderer-development.json` (macOS:
`~/Library/Application Support/Botling 2 Dev Trial/renderer-development.json`). This is outside the
app bundle and does not rely on a shell environment variable, source checkout, current working
directory or launch argument. Automatic persisted selection applies only to packaged developer
trials. Source/test launches keep their checkout assets unless given the explicit per-launch flag;
when using a source instance, pass `--outdir` to build/watch as shown above so it writes that instance's
assets even if an installed trial has a persisted output selection.

```sh
npm run renderer:configure -- --status
npm run renderer:configure -- --disable
```

Enabling validates a complete build before atomically writing the setting. Disabling keeps the
output files but restores bundled assets at the next ordinary launch. Configuration changes apply
at **startup**, so changing the selected directory or disabling it needs one controlled relaunch.
The current app does not acquire a new loader or change its selected directory through Cmd+R.
No further restart/repackaging is needed for compatible shell edits in the selected output.

A missing config means bundled assets; malformed/unsupported config or a missing/incomplete output
also falls back to bundled assets with a startup warning, rather than preventing startup. Restore
missing output explicitly with `renderer:build -- --outdir=...` before the next launch. A disconnected
disk can still break subsequent asset reads in an already running instance; reconnect it or use a
controlled bundled relaunch. Normal production artifacts ignore the dev-trial configuration and
launch override entirely. Developer asset responses use `Cache-Control: no-store`; packaged defaults,
custom origins and CSP remain unchanged.

The earlier `--botling-renderer-dir=/absolute/path` remains an optional per-launch override, with
precedence over saved configuration. It must reach the first process; passing it to an existing
instance does not switch directories. Invalid explicit launch arguments still fail visibly.

## Bounded live acceptance for the coordinator

Do this only after integration and separately approved deployment; `.10` predates persistent
configuration support and is not assumed installed. No runtime acceptance was performed by this
implementation worker.

1. Build compatible integrated sources into the stable output and enable it with the commands above.
   Install/launch normally, with **no** `--botling-renderer-dir`. Confirm startup reports
   `[renderer] loading /Volumes/My-SSD/botling-work/renderer-live`. Launching a replacement app version
   normally must select that same path.
2. In an idle, disposable test chat, retain a visible message and note the native chat page target.
   Add a temporary unique meta marker to the infrastructure-owned `src/renderer/index.html`, wait
   for ready, then invoke Cmd+R. The shell must expose the new marker while the original chat document
   and message remain, with no app/core process restart. Restore the source marker afterward.
3. With the opt-in disabled, a subsequent ordinary launch must use bundled assets. Production always
   uses bundled assets regardless of the saved dev-trial config.

For a hidden disposable fixture (only under the coordinator's existing hidden-runtime authorization),
launch the approved binary with `BOTLING_HIDDEN=1`, an explicit isolated data/import directory and
`--remote-debugging-port=<free-local-port>`, **without** `--botling-renderer-dir`. Keep focus opt-in
unset. CDP can reload only `app://botling/index.html` and inspect its marker plus the unchanged native
chat target/document; this establishes shell reload/loading behavior, not physical menu-key delivery.
Do not call bringToFront, focus, activate or send OS keystrokes. Physical Cmd+R acceptance remains a
separate user/manual check. The worker has not launched Electron, installed `.10`, or run this scenario.

## Refresh boundaries

| Change | How it takes effect |
| --- | --- |
| React shell components, layout, shell CSS/tokens/HTML, embedded shell avatars | Renderer build/watch, then Cmd+R; no app restart |
| Native chat renderer, chat CSS, composer, attachment UI or Web/src chat logic | Renderer build/watch, then View → Reload Chat Page (Alt+Cmd+R) or the `chat.reloadPage` command; chat state rehydrates from the core and unsent drafts are kept. Cmd+R still reloads only the shell |
| Shell preload (`src/preload/preload.ts`) or chat page preload (`src/preload/editor-host.ts`, `editor-bridge.ts`) | `npm run preload:build`, then Cmd+R (shell) or Reload Chat Page (chat); dev trial: `--botling-preload-dir` at launch |
| Core, agent runtime (Claude/Codex heads), bot engine, settings, components, plugin host program | `npm run core:build`, then Develop → Swap Core from Build (or `kill -USR2 <main pid>`); conversations resume in the same sessions. See [core-hot-swap.md](core-hot-swap.md) |
| Main process, native editor host (main side), IPC contracts (protocol version), the plugin host's utility wrapper | Full development build and app restart (or approved deployment for an installed trial) |
| New npm dependency/version, packaging, signing or Electron version | Relink/reinstall matching dependencies and rebuild/restart or package as appropriate |

This is manual shell refresh, not React Fast Refresh: it does not preserve arbitrary shell hook state.
Do not run the full `npm run build` alongside renderer watch: the full build intentionally clears
`out/`. Stop the watcher before a full rebuild, then start it again.

## Bounded checks

```sh
npm run renderer:build -- --outdir=/absolute/disposable/output
npm run typecheck
./node_modules/.bin/vitest run test/unit/renderer-refresh.test.ts \
  test/unit/renderer-loading.test.ts test/unit/renderer-configuration.test.ts test/unit/app-menu.test.ts test/unit/editor-host-main.test.ts \
  test/unit/chat-draft-keep.test.ts test/unit/preload-build.test.ts test/unit/contract.test.ts
# Hidden Electron check (never shows or focuses a window): reload, rehydrate, draft kept.
./node_modules/.bin/playwright test test/e2e/chat-reload-hidden.spec.ts
```

These use Node/esbuild, disposable renderer fixtures, protocol-response helpers and mocked native
editor lifecycles. They do not launch Electron or take focus. Native Cmd+R against the installed
trial remains an integration acceptance check; these tests do not claim that live UI evidence.
