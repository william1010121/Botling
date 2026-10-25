// Install before Web/src/main installs its capture guard. A native candidate keydown can be
// swallowed there, followed by an unflagged keypress whose keyCode is no longer 229.
import { compositionGrace, isComposingEnter, isComposingKey } from "../../../../Web/src/ime";

let imeCycle = false;
let endedAt = -Infinity;
window.addEventListener("compositionend", () => { endedAt = Date.now(); }, true);
const enter = (event: KeyboardEvent) => event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter";
window.addEventListener("keydown", event => {
  imeCycle = isComposingKey(event) || isComposingEnter(event);
}, true);
window.addEventListener("keypress", event => {
  if (!imeCycle || !enter(event)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
window.addEventListener("keyup", () => { imeCycle = false; }, true);
window.addEventListener("blur", () => { imeCycle = false; }, true);

/** Also retain ownership when the shared guard clears a stale composition flag on keydown. */
export function imeOwnsKey(event: KeyboardEvent): boolean {
  return imeCycle || isComposingKey(event) || isComposingEnter(event) || Date.now() - endedAt < compositionGrace;
}
