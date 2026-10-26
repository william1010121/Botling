# Updating the renderer without restarting Botling 2

Use the existing esbuild pipeline with a renderer-only watcher. No Vite server, new dependencies,
HTTP origin, HMR injection or CSP changes are needed. The watcher publishes compiled JS, HTML, CSS,
design tokens, character images and KaTeX assets to `desktop/out/renderer`. It never deletes `out/`
or rebuilds main, core, preloads or the plugin host. Wait for `[renderer] ready`, then press Cmd+R
(Ctrl+R on Windows/Linux) in the app. Builds with syntax/missing-input errors leave the previous
successful output available. Files publish by atomic rename; wait for ready before reloading to
avoid mixing files during publication. The watcher polls source metadata every 300 ms and also
handles atomic editor saves/new source directories.

## Source development workflow

From the chosen worktree (not the shared dirty checkout):

```sh
sh desktop/scripts/link-deps.sh
cd desktop
npm run build              # one initial shell/main/core/preload build, or after main/core changes
npm run renderer:watch     # keep this terminal running; does not launch or restart the app
```

In a second terminal, start an independently authorized development instance once:

```sh
cd /absolute/path/to/worktree/desktop
npm start
```

Then edit shell sources, wait for the ready line, and press Cmd+R. The native chat editor is
preserved by the existing app-menu fix (`553eeb8`); Reload and Force Reload still target the shell
webContents, never the focused native editor. Core processes and active agent work keep running.
Shell-local transient state can reset on reload. Source development continues to use that worktree's
`.data`; do not point an independent source instance at a running installed app's data directory.

For occasional updates, `npm run renderer:build` builds just the renderer once. For a separate asset
directory, either renderer command accepts `-- --outdir=/absolute/path/to/renderer-output`.
`node build.mjs --watch` now directs callers to `renderer:watch` instead of implying the full build
watches source changes.

## An installed developer trial (after integration and approved deployment)

A build containing this loader can opt into external renderer output at launch with:

```sh
npm run renderer:build
# Later, at an authorized launch of a dev-trial binary (example path):
"/Applications/Botling 2.app/Contents/MacOS/Botling 2" \
  --botling-renderer-dir=/absolute/path/to/worktree/desktop/out/renderer
npm run renderer:watch
```

Use the actual executable path for the installed trial. The flag must reach the **first process**;
passing it to an already running app does not switch directories. The main-process startup log
prints the selected renderer directory. The directory must be absolute and contain a complete
renderer build. Use sources compatible with that trial's main/core/preload contracts. The flag is
accepted only by unpackaged source launches and artifacts with the embedded `botlingDevTrial: true`
profile; ordinary packaged builds always load bundled assets, even if given the flag. Normal
launches without the flag continue to use their bundled renderer. Development responses use
`Cache-Control: no-store`; packaged default responses and both custom origins/CSPs remain unchanged.

The currently running trial cannot acquire this new loader through Cmd+R: one separately authorized
integration/deployment and initial launch are required. This implementation does not install,
restart, package or change the running app. Subsequent compatible shell edits require only build
(or watch) plus Cmd+R, with no repackaging or app restart.

## Refresh boundaries

| Change | How it takes effect |
| --- | --- |
| React shell components, layout, shell CSS/tokens/HTML, embedded shell avatars | Renderer build/watch, then Cmd+R; no app restart |
| Native chat renderer, chat CSS, composer, attachment UI or Web/src chat logic | Watch builds assets, but Cmd+R intentionally preserves the existing chat document. First version requires a controlled app restart to replace it; no live editor reload/HMR is implemented |
| Main process, preload, native editor host, core, agent runtime, plugin host, IPC contracts | Full development build and app restart (or approved deployment for an installed trial) |
| New npm dependency/version, packaging, signing or Electron version | Relink/reinstall matching dependencies and rebuild/restart or package as appropriate |

This is manual shell refresh, not React Fast Refresh: it does not preserve arbitrary shell hook state.
Do not run the full `npm run build` alongside renderer watch: the full build intentionally clears
`out/`. Stop the watcher before a full rebuild, then start it again.

## Bounded checks

```sh
npm run renderer:build
npm run typecheck
./node_modules/.bin/vitest run test/unit/renderer-refresh.test.ts \
  test/unit/renderer-loading.test.ts test/unit/app-menu.test.ts test/unit/editor-host-main.test.ts
```

These use Node/esbuild, disposable renderer fixtures, protocol-response helpers and mocked native
editor lifecycles. They do not launch Electron or take focus. Native Cmd+R against the installed
trial remains an integration acceptance check; these tests do not claim that live UI evidence.
