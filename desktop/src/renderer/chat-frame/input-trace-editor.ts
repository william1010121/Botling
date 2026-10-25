import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { InputTrace } from "../input-trace";

const observed = new WeakSet<EditorView>();
export function editorTraceSnapshot(view: EditorView | null): Record<string, unknown> {
  if (!view) return { editor: null };
  const dom = [...view.contentDOM.querySelectorAll(".cm-line")].map(line => line.textContent).join("\n");
  const raw = view.contentDOM.textContent;
  return { domTextContent: raw?.slice(0, 8192), domTextContentLength: raw?.length, cmDoc: view.state.doc.toString().slice(0, 8192), cmLength: view.state.doc.length,
    domDoc: dom.slice(0, 8192), domLength: dom.length, selection: view.state.selection.toJSON(), composing: view.composing };
}
/** Wrap public methods only in tracing tests. In particular, never dispatch an extension or flush
 * CodeMirror's DOM observer: that could hide the unread-native-DOM hypothesis being measured. */
export function traceEditorView(trace: InputTrace, view: EditorView): void {
  if (observed.has(view)) return;
  observed.add(view);
  trace.mark("editor.observe", () => ({ editor: trace.node(view.contentDOM), ...editorTraceSnapshot(view) }));
  const dispatch = view.dispatch;
  view.dispatch = function (...args: any[]) {
    const cause = trace.mark("editor.dispatch.before", () => ({ editor: trace.node(this.contentDOM), ...editorTraceSnapshot(this) }));
    let completed = false;
    try { const result = Reflect.apply(dispatch, this, args); completed = true; return result; }
    finally { trace.mark("editor.dispatch.after", () => ({ cause, completed, ...editorTraceSnapshot(this) })); }
  };
  const update = view.update;
  view.update = function (transactions) {
    trace.mark("editor.transactions", () => ({ editor: trace.node(this.contentDOM), ...editorTraceSnapshot(this),
      transactions: transactions.map(tr => ({ userEvent: tr.annotation(Transaction.userEvent), remote: tr.annotation(Transaction.remote),
        docChanged: tr.docChanged, startDoc: tr.startState.doc.toString().slice(0, 8192), doc: tr.newDoc.toString().slice(0, 8192),
        selection: tr.state.selection.toJSON() })) }));
    return Reflect.apply(update, this, [transactions]);
  };
}
