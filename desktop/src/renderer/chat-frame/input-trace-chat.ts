import { EditorView } from "@codemirror/view";
import { TEST_TRACE_QUERY } from "../../test-trace";
import { createInputTrace, inputTrace, setInputTrace, traceDocumentEvents } from "../input-trace";
import { editorTraceSnapshot, traceEditorView } from "./input-trace-editor";
import { APP_ORIGIN } from "./protocol";

const composer = () => {
  const dom = document.querySelector<HTMLElement>(".composer .cm-editor");
  return dom ? EditorView.findFromDOM(dom) : null;
};
export function observeTraceEditor(): void {
  const trace = inputTrace();
  const view = trace ? composer() : null;
  if (view && trace) traceEditorView(trace, view);
}
// Only the shell with a main-provided test capability adds this query. A standalone query cannot
// persist records: the shell relay and the main writer independently require that capability.
if (new URLSearchParams(location.search).get(TEST_TRACE_QUERY) === "1") {
  const trace = createInputTrace("chat", window, record => parent.postMessage({ botling: "testTrace", record }, APP_ORIGIN),
    () => {
      const view = composer();
      return { chat: document.documentElement.dataset.chat, ...editorTraceSnapshot(view),
        editor: view ? inputTrace()?.node(view.contentDOM) : null };
    });
  setInputTrace(trace);
  traceDocumentEvents(trace, window);
  const seen = new WeakSet<HTMLIFrameElement>();
  const inserted = (root: Node) => {
    const element = root as Element;
    const frames = [...(element.querySelectorAll?.("iframe") ?? [])] as HTMLIFrameElement[];
    if (element.nodeName === "IFRAME") frames.unshift(element as HTMLIFrameElement);
    for (const frame of frames) {
      if (seen.has(frame)) continue;
      seen.add(frame);
      trace.mark("card.iframe.insert", () => ({ frame: trace.node(frame), ...trace.snapshot() }));
    }
  };
  // Capture load includes descendant iframe loads without reading a cross-origin document.
  document.addEventListener("load", event => {
    if ((event.target as Element | null)?.nodeName === "IFRAME")
      trace.mark("card.iframe.load", () => ({ frame: trace.node(event.target), ...trace.snapshot() }));
  }, true);
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) inserted(node);
    observeTraceEditor();
  }).observe(document.body, { childList: true, subtree: true });
  inserted(document.body);
  trace.mark("document.start", () => trace.snapshot());
}
