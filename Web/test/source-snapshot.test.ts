import { describe, expect, it, vi } from "vitest";
import { requestSourceSnapshot, sourceSnapshotScript, staticSourcePage } from "../src/source-snapshot";
describe("static source cards", () => {
  it("captures an existing card retaining picks and notes without executing its template", () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = '<style>.option{color:orange}</style><input type="checkbox"><textarea>old</textarea><button onclick="evil()">Run</button><script>evil()</script><iframe srcdoc="bad"></iframe>';
    doc.querySelector<HTMLInputElement>("input")!.checked = true;
    doc.querySelector<HTMLTextAreaElement>("textarea")!.value = "actual note";
    let receive: ((event: unknown) => void) | undefined;
    const parent = {postMessage: vi.fn()};
    new Function("window", "document", "parent", sourceSnapshotScript)({addEventListener: (_: string, fn: typeof receive) => receive = fn}, doc, parent);
    receive!({source: {},data:{ccbSourceSnapshot:"wrong"}});
    expect(parent.postMessage).not.toHaveBeenCalled();
    receive!({source:parent,data:{ccbSourceSnapshot:"actual"}});
    const snapshot = parent.postMessage.mock.calls[0][0];
    expect(snapshot.request).toBe("actual");
    const copy = new DOMParser().parseFromString(snapshot.html, "text/html");
    expect(copy.querySelector("input")?.hasAttribute("checked")).toBe(true);
    expect(copy.querySelector("textarea")?.textContent).toBe("actual note");
    expect(copy.querySelector("style")?.textContent).toContain("orange");
    expect(copy.querySelectorAll("script,iframe,[onclick],input:not([disabled]),button:not([disabled])")).toHaveLength(0);
    expect(doc.querySelector<HTMLInputElement>("input")?.disabled).toBe(false);
    expect(doc.querySelector("iframe")).not.toBeNull();
  });
  it("makes hostile snapshot HTML inert while preserving image bytes", () => {
    const original = '<!doctype html><style>.picked{color:orange}</style><button class="picked" onclick="parent.postMessage(1)">Stable</button><script>parent.postMessage(2)</script><form action="https://evil"><input autofocus></form><img src="data:image/png;base64,aGVsbG8="><iframe srcdoc="bad"></iframe><a href="https://evil">Navigate</a>';
    const doc = new DOMParser().parseFromString(staticSourcePage(original, "Stable"), "text/html");
    expect(doc.querySelectorAll("script,iframe,[onclick],[href],[action],[autofocus]")).toHaveLength(0);
    expect(doc.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(doc.querySelector("mark")?.textContent).toBe("Stable");
    expect(doc.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content")).toContain("script-src 'none'");
  });
  it("rejects other frames and incorrect or expired requests", async () => {
    const frame = document.createElement("iframe");document.body.append(frame);
    const send = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    const result = requestSourceSnapshot(frame, 20);
    const request = send.mock.calls[0][0].ccbSourceSnapshot;
    window.dispatchEvent(new MessageEvent("message",{source:window,data:{ccb:"sourceSnapshot",request,html:"bad"}}));
    window.dispatchEvent(new MessageEvent("message",{source:frame.contentWindow,data:{ccb:"sourceSnapshot",request:"wrong",html:"bad"}}));
    expect(await result).toBeNull(); frame.remove();
  });
});
