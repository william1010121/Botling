# Embedded terminal checks

Run from `desktop/`. These harnesses use private profiles, hidden windows and temporary shell
configuration. They never start the Botling core or read the live app's data directory.

- `npx vitest run test/unit/terminal.test.ts test/unit/app-menu.test.ts`: ownership, strict requests,
  multiple tabs, bot separation, retained output, resize, control/binary input, exit/restart,
  shutdown admission, backpressure, late events, listener disposal and native shortcut routing.
- `node test/terminal/build.mjs`: stage the production terminal implementation and preload in an
  isolated Electron harness. It does not package or launch the app.
- `env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron out/terminal-harness/lifecycle.cjs`:
  20 hidden-window cycles, 40 real PTYs. Close/reopen tabs while output streams, destroy the owner,
  and shut down (including a shell that ignores SIGHUP). Require zero remaining PTYs/listeners.
- `node test/terminal/smoke.mjs`: interact with the actual React panel and xterm through Electron.
  On this macOS host it exercises `/bin/zsh`, `/opt/homebrew/bin/fish`, `/opt/homebrew/bin/fzf`
  and an existing Powerlevel10k theme. Set `TERMINAL_P10K_THEME` for a different theme location.
  The shell config lives only in the temporary harness HOME/ZDOTDIR. It tests selection, native
  copy/paste, control keys, fullscreen fzf, resize, per-tab/per-bot state, hide/show and restart.
  Clipboard text is restored in `finally`. Screenshots and results go to
  `out/terminal-harness/evidence/`. This host-specific smoke requires the indicated fish/fzf tools;
  do not install them globally merely to run it.
- `node test/terminal/asar-smoke.mjs --preflight-only`: build a tiny native-layout fixture, wait for
  the ASAR writer's **finished** event, extract/byte-compare and JSON-parse the exact manifest,
  verify entry bytes, native unpack location, and helper executable permission. No Electron launch.
- `node test/terminal/asar-smoke.mjs`: the same preflight, then load the fixture through a plain
  fail-fast bootstrap. This tests native PTY loading from app.asar + app.asar.unpacked, not a full
  app package. Test exceptions exit nonzero on stderr, never through Electron's error dialog.

## Integration contract

The production main process owns PTYs. Only its trusted app main frame receives the preload
capability. Main resolves cwd from the core's bot snapshot; the renderer cannot send cwd, env,
executable arguments or an arbitrary executable. Shell paths must be discovered installed shells.
Each request containing a session is checked against both its owner WebContents and bot ID.

Tabs and output exist in memory only. Cmd+J and tab switching do not spawn processes. New-tab does;
close-tab stops only its PTY. Bot removal and owner destruction dispose subscriptions before
signalling PTYs. Shutdown rejects new opens and waits for terminal cleanup. It sends SIGHUP first,
then force-kills a still-identical shell/process group after 300 ms. It does not track deliberately
detached daemons. It does not persist/replay commands, register in the agent process ledger, or
participate in thread/subagent recovery.

Merge `src/main/main.ts` lifecycle additions into the existing Restart anyway shutdown hook;
retain its current recovery behavior. The terminal shutdown promise joins the existing shutdown
wait. Core restart/hot swap does not replay or restart a terminal.

## Runtime packaging

`stageTerminalRuntime` copies node-pty beside the bundled main entry and fixes spawn-helper's
executable bit in **output only**. The shared dependency installation remains untouched. The
native runtime is external to esbuild and unpacked by electron-builder. Its N-API prebuild was
executed successfully on macOS arm64 under Electron 44.9.3 (modules 149, N-API 10), including the
ASAR layout. No Electron ABI rebuild was needed on this host. Other platforms/architectures and
signed full-app packaging still require their integration validation.

xterm 6.0.0, fit 0.11.0, Unicode11 0.9.0 and node-pty 1.1.0 use MIT licences. The bundled MesloLGS
font carries its upstream Apache licence and needs no system installation. Node-pty's staged
multi-platform prebuilds occupy about 58 MB uncompressed; the font is about 2.5 MB. The shell CSP
permits inline styles for xterm's dynamic sizing/styles; scripts, frames and networking retain
the existing restrictions. Terminal output receives no Node APIs or command-link handlers.
