# E3 test trace integration contract

Source base: `11bbc805727da3303d1a0bc8f6f4beb89f0d06e6`. Source instrumentation only. No Electron, GUI, focus emulation or native-key run has been performed with it. H1 (hasFocus gating) and H2 (unread DOM overwritten by a programmatic transaction) remain hypotheses. No focus behavior fix is included.

## Main/harness ownership: integration worker 9375b9e1

This branch intentionally does not edit main, its JSONL writer, the launch harness, F0 or the broker. Preload and renderer plumbing is ready for the following main-owned interface:

1. Enable only when **all** are true: unpackaged development app, `BOTLING_TEST_TRACE=1`, fake agent, an explicitly supplied disposable `BOTLING_DATA_DIR` created by the test harness under My-SSD, and a validated synthetic-fixture marker there. Suggested marker: `.botling-synthetic-test.json` containing `{ "v": 1, "fixture": "composer-race", "runId": "...", "testId": "..." }`. Refuse any real/default/imported user-data directory. A renderer cannot supply or choose a file path.
2. When enabled, add `additionalArguments: ["--botling-test-trace=1"]` to **only** the shell BrowserWindow's webPreferences (merge existing additionalArguments). Existing preload then exposes `window.__botlingTestTrace = { protocol: 1, emit(record) }`. This argument is not a user-level substitute for the gate above. Never pass it to remote websites, cards, screenshots or recovery windows. Main must enforce the gate again on receipt, even if someone manually supplied an argument.
3. Register `ipcMain.on("botling:test-trace", (event, record) => ...)` before creating/loading the window. Require an owned app webContents, its top/main sender frame, and the exact app shell origin `app://botling`; reject all other senders. Import `isTestTraceRecord` and `TEST_TRACE_CHANNEL` from `src/test-trace.ts`. Validate only after the test gate; reject malformed or >256 KiB records. This is a separate diagnostic channel, never a core contract command.
4. Append one JSON object per line to **fixed** `join(dataDir, "input-trace.jsonl")` inside that verified synthetic directory. Include the untouched renderer record plus main `writerSeq`, `receivedAt` (Date.now), and webContents/frame identity. Preserve renderer `at` and `seq`; do not replace them with IPC arrival time. Put runId/testId/focusEmulation mode in a run header. Use a bounded queue/file limit, report truncation or dropped records explicitly, and drain/flush before reporting test shutdown complete. Test fixtures may contain full composer text; real-user text must never enter this sink.
5. The current composer spec still contains two real OS `BrowserWindow.blur()/focus()` cases (the tests named `native Electron window blur...`). They must remain deferred/excluded for hidden ON/OFF runs; never execute them merely because the file-wide focus opt-in is set. `BOTLING_HIDDEN=0` cases also require the F0 owner to enforce actual hidden creation or exclude them. This branch leaves those test definitions and safety ownership unchanged.
6. The F0 hidden-window safety gate and frontmost-before/during/after proof are independent prerequisites. Tracing does not authorize a GUI run. Do not set OS focus, activate, show, relaunch, or calibrate a window. The coordinator has not relayed an accepted F0 proof for this worker.

Useful main-owned hooks, with the same epoch-ms clock: window/webContents focus/blur, renderer focus-emulation mode changes, document navigation/commit, `did-frame-finish-load`, and trace writer flush/drop status. These are observations only. Do not invoke focus to generate them.

## Wire and correlation

Every record has `{ v:1, scope:"shell"|"chat", generation, timeOrigin, at, seq, event, data }`. `at = performance.timeOrigin + performance.now()`. `generation = scope + ":" + timeOrigin`; node ids are local to that generation. Merge by renderer epoch and per-generation sequence while retaining writer order as separate evidence. This is clock correlation, not a claim of strict cross-process causal ordering.

Optional `traceId` fields on existing `state`, `recoverFocus` and `composerIntent` messages correlate send/receive. IDs are `<generation>/<seq>` of the send record. They are absent with tracing off. Chat records use `{botling:"testTrace", record}` via parent.postMessage. The shell relay accepts only `#chat-frame.contentWindow` at `botling-chat://chat`, and only validated chat records, before sending the separate IPC channel. No link/action/broker envelope is modified.

Only the shell with the preload capability appends `?__botling_test_trace=1` to the chat URL. The chat bootstrap runs before the shared IME guard and Web main. A query alone does not create a privileged relay or writer. The new query means the existing test `chatFrame()` helper's exact `url.endsWith("/chat.html")` needs a **main/harness owner** adjustment to compare `new URL(url).pathname === "/chat.html"` and the expected chat origin; do not weaken source/origin checks. This branch does not touch the owned harness.

## Event vocabulary (D3 can share these names)

- `document.start`; `dom.<type>` and `dom.<type>.after` for keydown/keypress/keyup, beforeinput/input, composition start/update/end, focus/blur/focusin/focusout, pointerdown and visibilitychange. After records reference capture via `cause`, even if propagation was stopped. They include target/relatedTarget, activeElement, hasFocus, trust/prevention/IME/modifier flags and input data. Chat snapshots additionally include CodeMirror/DOM text, lengths, selection, composing and chat id.
- `shell.state.send` → `frame.state.receive`; `frame.early.snapshot`, `frame.state.applied`, `frame.keepTyped.before/after`, `frame.state.complete`.
- `frame.composerIntent.send` → `shell.composerIntent.receive/applied/stale`; `shell.intent.explicit`; `frame.intent.change`, `frame.loss.observed`, `frame.editor.replaced`, `frame.bodyText.buffered`, `frame.flush.before/after/noEditor`.
- `shell.recover.timer.schedule/cancel/fire`; `shell.recover.check/blocked/explicitTarget`, `shell.recover.focus.before/after`; `shell.recover.send` → `frame.recover.receive`; `frame.recover.check/blocked`, `frame.recover.focus.before/after`. Snapshots retain deadlines, intention, generation, window focus and wall-clock now. Calling focus is **not** proof that focus moved; compare before/after snapshots.
- `editor.observe`, `editor.dispatch.before/after`, `editor.transactions`: each transaction includes userEvent, remote annotation, start/new document, selection and docChanged. The wrapper observes public dispatch/update and never flushes the DOM observer or dispatches a tracing extension. This permits distinguishing an unread DOM `ea` from CM `e` before a programmatic overwrite. That mismatch in a unit fixture is not evidence H2 occurred in round 5.
- `card.iframe.insert/load`: stable parent-document node identity and focus/editor snapshot. This worker does not trace inside card realms or touch D3 broker logic. D3 can correlate its broker records with the same generation/node/event vocabulary; iframe inner-document generation still requires main-owned navigation events.

Both line-joined DOM text and raw contentDOM.textContent are recorded (including text outside a .cm-line). Text snapshots are clipped to 8192 code units and include original lengths. Test trace overhead can change timing; no hidden run establishes real OS focus or native IME correctness. The existing strengthened IME keydowns with text payloads and E7/E8 guards are preserved.

## Still pending

Main/harness integration above; F0 accepted commit plus frontmost proof; actual end-to-end JSONL delivery/flush validation; authorized hidden composer runs with emulation ON/OFF only if both satisfy F0. No GUI test was run or counted skipped-as-passed here. E3 remains incomplete until causal trace evidence and an evidence-supported correction exist.


## Source-only check evidence

Targeted Node/Vitest checks (no app build): input-trace 11, mocked preload 4, existing composer-focus 25 and composer-ime 5. Total 45 tests. TypeScript `--noEmit -p tsconfig.json` is checked separately. These validate diagnostic contracts, not main IPC persistence or browser/native behavior. The preload parameterized fixture initially supplied undefined argv and was corrected; that failure is not production bug evidence.
