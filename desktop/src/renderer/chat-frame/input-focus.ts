import type { EditorView } from "@codemirror/view";
import type { FrameMessage } from "./protocol";
import { imeOwnsKey } from "./input-ime";
import { inputTrace } from "../input-trace";

/** The chat document owns recovery. Kept separate so event/state ordering can be checked without
 * launching a browser. Native key routing and activation still require an authorized GUI check. */
export function installInputRecovery(
  composerView: () => EditorView | null,
  toShell: (message: Extract<FrameMessage, { botling: "composerIntent" }>) => void,
): () => boolean {
  // A loss opens a short recovery window, even when a slow welcome/editor replacement occurs long
  // after module evaluation. Pointer/Tab intent cancels it. No editing keys cross origins.
  const RECOVERY_MS = 3_000;
  let composerIntended = true;
  let recovering = true;
  let recoveryUntil = Date.now() + RECOVERY_MS;
  let lastEditor = composerView()?.contentDOM ?? null;
  let editorHadFocus = false;
  const pendingText = new Map<string, string>();
  const chatKey = () => document.documentElement.dataset.chat ?? "";
  const inBox = (target: EventTarget | null) => !!(target as HTMLElement | null)?.closest?.(".composer .cm-content");
  const emptyFocus = () => document.activeElement === document.body || document.activeElement === document.documentElement;
  const mark = (event: string, extra: Record<string, unknown> = {}) => inputTrace()?.mark(event, () => ({
    composerIntended, recovering, recoveryUntil, editorHadFocus, now: Date.now(),
    lastEditor: inputTrace()!.node(lastEditor), pendingText: [...pendingText], ...inputTrace()!.snapshot(), ...extra,
  }));
  function announce() {
    const traceId = mark("frame.composerIntent.send");
    toShell({ botling: "composerIntent", value: composerIntended, recoveryUntil: recovering ? recoveryUntil : 0,
      startedAt: performance.timeOrigin, ...(traceId ? { traceId } : {}) });
  }
  function intendComposer(value: boolean) {
    mark("frame.intent.change", { value });
    composerIntended = value;
    if (!value) { recovering = false; recoveryUntil = 0; }
    announce();
  }
  function noteLoss() {
    mark("frame.loss.observed");
    if (!composerIntended || recovering) return;
    recovering = true;
    editorHadFocus = false;
    recoveryUntil = Date.now() + RECOVERY_MS;
    announce();
  }
  function detectLoss() {
    const editor = composerView()?.contentDOM ?? null;
    const replaced = lastEditor !== editor;
    lastEditor = editor;
    if (replaced) mark("frame.editor.replaced", { editor: inputTrace()?.node(editor) });
    if (emptyFocus() && (editorHadFocus || replaced)) noteLoss();
  }
  function flushText(): boolean {
    const view = composerView();
    if (!view) { mark("frame.flush.noEditor"); return false; }
    const key = chatKey();
    const text = (pendingText.get("") ?? "") + (key ? pendingText.get(key) ?? "" : "");
    if (text) {
      mark("frame.flush.before", { text });
      pendingText.delete(""); pendingText.delete(key);
      view.dispatch(view.state.replaceSelection(text), { userEvent: "input.type" });
      mark("frame.flush.after");
    }
    return true;
  }
  function takeFocusBack(): boolean {
    detectLoss();
    mark("frame.recover.check");
    if (!composerIntended || !recovering || Date.now() >= recoveryUntil || !emptyFocus() || !document.hasFocus()) {
      mark("frame.recover.blocked"); return false;
    }
    if (!flushText()) return false;
    mark("frame.recover.focus.before");
    composerView()?.focus();
    mark("frame.recover.focus.after");
    return true;
  }
  document.addEventListener("pointerdown", event => {
    if (!inBox(event.target)) intendComposer(false);
    else {
      composerIntended = true;
      if (emptyFocus()) { recovering = false; noteLoss(); }
    }
  }, true);
  document.addEventListener("keydown", event => {
    if (event.key === "Tab" || event.key === "Escape") intendComposer(false);
  }, true);
  document.addEventListener("focusout", event => {
    if (inBox(event.target) && !event.relatedTarget) noteLoss();
  }, true);
  document.addEventListener("focusin", event => {
    if (event.target === document.body || event.target === document.documentElement) return;
    if (inBox(event.target)) {
      flushText();
      composerIntended = true; recovering = false; recoveryUntil = 0; editorHadFocus = true;
      lastEditor = composerView()?.contentDOM ?? null;
      announce();
    } else intendComposer(false);
  }, true);
  // DOM removal can omit focusout entirely. Observe replacement and empty-body focus directly,
  // without polling or treating ordinary window blur as a keyboard handoff.
  new MutationObserver(() => { detectLoss(); takeFocusBack(); }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("focus", takeFocusBack);
  document.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.key === "Tab" || event.key === "Escape"
        || imeOwnsKey(event) || composerView()?.composing) return;
    // Printable text is handled at its original keypress, with the default cancelled before focus
    // changes. Relying on keydown's focus change to redirect native text can lose or duplicate it.
    if (Array.from(event.key).length === 1) return;
    if (!takeFocusBack()) return;
    const key = new KeyboardEvent("keydown", { key: event.key, code: event.code, shiftKey: event.shiftKey,
      bubbles: true, cancelable: true });
    composerView()?.contentDOM.dispatchEvent(key);
    if (key.defaultPrevented) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  document.addEventListener("keypress", event => {
    if (!event.isTrusted || event.defaultPrevented || event.metaKey || event.ctrlKey || imeOwnsKey(event) || composerView()?.composing
        || !emptyFocus() || Array.from(event.key).length !== 1 || /[\u0000-\u001f\u007f]/u.test(event.key)) return;
    detectLoss();
    if (!composerIntended || !recovering || Date.now() >= recoveryUntil) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const key = chatKey();
    pendingText.set(key, (pendingText.get(key) ?? "") + event.key);
    mark("frame.bodyText.buffered", { key: event.key });
    // Apply the prefix synchronously before later native edits; if the editor is being replaced,
    // its mutation callback flushes the text once that same chat has an editor again.
    if (flushText()) takeFocusBack();
  }, true);
  announce();
  return takeFocusBack;
}
