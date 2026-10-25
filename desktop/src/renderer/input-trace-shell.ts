import { isTestTraceRecord, type TestTraceBridge } from "../test-trace";
import { APP_ORIGIN, CHAT_ORIGIN } from "./chat-frame/protocol";
import { createInputTrace, setInputTrace, traceDocumentEvents } from "./input-trace";

// Only main's gated, synthetic-data preload argument exposes this capability. No environment,
// query string or localStorage in the shell enables it. Remote/card pages never receive it.
const bridge = (window as unknown as { __botlingTestTrace?: TestTraceBridge }).__botlingTestTrace;
if (bridge?.protocol === 1) {
  const trace = createInputTrace("shell", window, record => bridge.emit(record));
  setInputTrace(trace);
  traceDocumentEvents(trace, window);
  window.addEventListener("message", event => {
    const frame = document.getElementById("chat-frame") as HTMLIFrameElement | null;
    if (location.origin !== APP_ORIGIN || event.origin !== CHAT_ORIGIN || event.source !== frame?.contentWindow
        || event.data?.botling !== "testTrace" || !isTestTraceRecord(event.data.record) || event.data.record.scope !== "chat") return;
    bridge.emit(event.data.record);
  });
  trace.mark("document.start", () => trace.snapshot());
}
