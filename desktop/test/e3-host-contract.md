# E3 main/preload/build boundary contract — source only, dormant

Decision based on input-worker commit `8c62643802724287d8ad87fe947a7d77be08c88e`, `test/e3-owner-boundary.md`. Implementation authorization covers this boundary; it does not authorize runtime. STOP remains persisted and must not be reset. This contract does not claim the current `naXb` acceptance passes.

## Decision and limits

Do **not** move plugins into the privileged shell or embed privileged controls under an untrusted parent. Keep `app://botling/index.html` as the trusted shell, with its existing full bridge and DOM isolated. Provision the existing Composer + synchronous PluginHost together in **one separate main-owned WebContentsView**, whose unprivileged **root document** is `botling-chat://chat/chat.html?nativeHost=1`. Root here means the native editor WebContents' main document, not the privileged BrowserWindow document.

This avoids privileged root/plugin cohabitation, moving trusted controls into plugin-readable DOM, duplicating editors, or reconstructing native commands from delayed text. It is a native surface/transport change, not an IPC keyboard retargeter. The strict native-order requirement remains one actual editor. A native view alone does not prove first-key ownership.

The implemented factory is **dormant**. No current window calls `prepareNativeEditorHost`, receives the shell opt-in argument, mounts a native host, changes focus, or changes its legacy primary iframe. No runtime environment flag enables it. Existing product behavior and full `fromAppFrame()` authorization are unchanged. Build output is not regenerated in this pass.

## Main owner API and trust

Files: `src/main/editor-host.ts`, `editor-host-boundary.ts`, the narrow native navigation hook in `main.ts`.

`prepareNativeEditorHost(ownerWindow, desktopRoot, ownerReadyPromise)` is a **main-only** API. It requires a still-hidden owner, creates one sandboxed/context-isolated view with Node, workers and subframe Node integration disabled, and assigns only `out/preload/editor-host.cjs`. It starts at zero bounds, exposes `{view, ready, dispose}`, and never calls native focus, app activation or window show. The caller must keep the window hidden until integration prerequisites below are met.

Main binds actual shell/editor WebContents objects and their current main-frame objects. Origin, numeric ID, a renderer-supplied stamp, or a copied URL is insufficient. Pairing requires the exact shell root URL and exact native editor URL. Main routes up only to that pair's shell and down only to that pair's editor. It never forwards an editor packet to `core.request`, never adds the editor to `appContents`, and does not relax `fromAppFrame()`.

`surfaceId` is stable for a native view's lifetime. `documentGeneration` is an opaque **pair-binding generation**, rotated on shell document replacement; it is not the editor's text revision or performance timeOrigin. Old generations are refused. Shell navigation revokes the pair and sends `unbound`; a new authenticated shell load rebinds the same native view without loading/remounting its editor. Unexpected editor-root navigation closes/revokes that host instead of quietly replacing its native editor state. Crash/owner-close removes the pair/listeners and closes only its own view.

Native root initial navigation is restricted to its exact URL. Root reload after binding is not an editing recovery path. Direct card/page children and preview children of component pages retain the existing hierarchy restrictions; app/file/remote/chat escape frames, popups and webviews are refused. The legacy primary chat iframe is refused for owners with a native host; the existing `?spec=1` child remains a separate legacy surface whose readonly behavior must be checked before activation. Existing card/result/author checks remain in shell/core, unchanged.

Only the authenticated shell may change native-view bounds. Bounds must fit the owner's content area. `null` hides it using zero bounds while retaining the editor (Settings, Web, modal or other explicit control selection); restoring bounds must not recreate it. Editor/plugin messages cannot move the view or invoke full IPC.

## Preload/build API

`build.mjs` adds only `out/preload/editor-host.cjs`; it uses the existing chat bundle, HTML and CSS. No plugin code is bundled into the shell. No build/package has been run here.

The dedicated native preload requires **all three**: main frame, exact native editor URL, main-provided `--botling-editor-host=1`. It exposes only `window.botlingEditor`, never `window.botling`, raw ipcRenderer, event objects, accounts/secrets APIs or test trace capability. A URL/query/argument alone grants no main authority.

The existing trusted preload gains an optional `window.botling.editorHost` **only** with main-provided `--botling-editor-shell=1`. Current `createWindow()` does not pass it. Its main/full bridge and test-trace behavior otherwise remain unchanged.

Both narrow bridges:

- `version: 1`
- `current(): {surfaceId, documentGeneration} | null`
- `subscribe(fn)`: delivers `{stamp, bound:true}`, `{stamp, unbound:true}` or `{stamp, message}`; never an Electron event. A subscriber added after binding immediately receives current bound metadata.
- `post(message): boolean`: local validation/queueing only, **not** core completion. It refuses while unbound. Existing request/response IDs still determine completion. On unbind, the input adapter must retain the EditorView and its text/history/composition, reject/mark undelivered outstanding business requests, and wait for authenticated rebinding; never replay edits or silently claim a send succeeded.
- `layout(bounds | null): boolean`: shell only. Editor calls always return false. No mount, native focus, key injection, execution, navigation or arbitrary IPC method is exposed.

Channels are fixed in `src/editor-host-wire.ts`: `botling:editor:bound`, `:unbound`, `:up`, `:down`, `:shell`, `:layout`. These are diagnostic-independent application transport, not the E3 trace channel.

## Protocol contract for input worker

No edits were made to the input-owned `chat-frame/protocol.ts`. The additional wire module owns transport only. Up payloads retain existing action/link provenance, `card.save`/`card.action` requests, stop, message width and component-page requests. Arbitrary core commands are rejected. `hostObservation` may carry `{chatId, intentEpoch, revision}` as metadata; it cannot change ownership or text. Up is capped at 1 MiB; down at 16 MiB. Cycles/invalid packets are refused.

Down retains state, plugins, card/business replies, width, spec and task observations. `focus`, `recoverFocus`, key events, edit replay and composition transport are absent/refused. Explicit native focus/initial-owner selection stays main-owned and is **not implemented by this transport**. Any future explicit focus operation needs the existing real user-intent/cancellation semantics and separate owner integration; no delayed event may become an editing commit.

The input worker may now prepare native transport adapters, stable editor mount/reference and same-document recovery against this API in its own branch. Intended input-owned wiring: App's primary chat placeholder/state dispatch; chat-frame entry/shim/component transport adapters; protocol metadata; the existing Composer/PluginHost kept together. Replace only authenticated transport/source gates, preserving card command restrictions and author-bound link routing. Link authorization hunks remain integration-owned; coordinate any logical change there. Leave SpecFrame, accounts, settings, results, updater and unrelated design behavior intact.

The legacy iframe mode remains the default until coordinated integration. In native mode, capability presence selects native transport **before** creating a legacy iframe; an unbound native bridge is not permission to fall back to a second editor. State observations never replace a live EditorView/selection/history/composition. Explicit chat navigation remains the existing draft/history-switch boundary.

## Activation prerequisites and honest acceptance

After the worker supplies its adapter/mount changes, the main owner must integrate the dormant factory and shell argument together, remove the legacy primary iframe in that mode, coordinate native-view bounds/hiding with Settings/Web/modal/Spec surfaces, retain hidden/prohibited-before-ready gates, and gate reveal on editor initialization, initial layout and the intended native input owner. Native focus/first-key ordering is not supplied by a postMessage ACK or this factory. Do not silently activate half of this contract.

Keep the production routing assertion `naXb`; do not make the failing shell-BODY route green by inserting directly into Composer, replaying keys, weakening expectations, or selecting a friendlier event order. The actual mounted native owner must receive root/BODY operations before observations; `n`/Backspace/Undo, paste/selection/history, composition and explicit Tab/control cancellation remain required. If first input still enters the privileged shell, the requirement is not satisfied.

Current evidence is **non-GUI security/lifecycle tests and typecheck only**. No mounted native editor, native routing, GUI sampler, IME, E3 fix, 20-round gate, build or package claim is made. Existing runtime/DMG evidence is from earlier source and does not validate this boundary. STOP and all prior failures are preserved.
