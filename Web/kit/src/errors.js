// The error card: what a card shows instead of a blank frame when its component throws, its
// markup is malformed (check.js) or its script fails. It also sets the pin's status ("Error", bad)
// and logs the error, so the bot and the user both see something went wrong.
import { h, Component } from "preact";

const title = "This card could not be drawn";
const hint = "The component's template has a mistake; the bot can fix it.";

function text(error) {
  if (error instanceof Error) return (error.name && error.name !== "Error" ? error.name + ": " : "") + error.message;
  return String(error);
}

function tell(error) {
  try { console.error(error); } catch { /* no console */ }
  try {
    const ccb = window.ccb;
    if (ccb && typeof ccb.setStatus === "function") ccb.setStatus({ text: "Error", tone: "bad" });
  } catch { /* no status here */ }
}

/** The error card as a block, for a component's own errors: <${ErrorCard} error=${e} />. */
export function ErrorCard({ error, title: heading = title }) {
  return h("div", { class: "ccb-error", role: "alert" },
    h("div", { class: "ccb-error__title" }, h("span", { class: "ccb-error__icon", "aria-hidden": "true" }, "!"), heading),
    h("pre", { class: "ccb-error__message" }, text(error)),
    h("div", { class: "ccb-error__hint" }, hint));
}

/** Catches what its children throw while drawing and shows the error card in their place. */
export class Boundary extends Component {
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { tell(error); this.setState({ error }); }
  render() { return this.state.error ? h(ErrorCard, { error: this.state.error }) : this.props.children; }
}

let card = null;
/**
 * Shows `error` as the error card at the top of the page (plain DOM, so it works even when
 * drawing is what failed). One card: a later error replaces its text.
 */
export function showError(error) {
  tell(error);
  const root = document.getElementById("ccb-root") || document.body;
  if (!root) return;
  if (!card || !card.isConnected) {
    card = document.createElement("div");
    card.className = "ccb-error ccb-error--page";
    card.setAttribute("role", "alert");
    const head = document.createElement("div");
    head.className = "ccb-error__title";
    const icon = document.createElement("span");
    icon.className = "ccb-error__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "!";
    head.append(icon, title);
    const message = document.createElement("pre");
    message.className = "ccb-error__message";
    const tip = document.createElement("div");
    tip.className = "ccb-error__hint";
    tip.textContent = hint;
    card.append(head, message, tip);
    root.prepend(card);
  }
  card.querySelector(".ccb-error__message").textContent = text(error);
}

/** Uncaught errors and rejections of the template's scripts become the error card. */
export function watchErrors() {
  window.addEventListener("error", (event) => {
    // The browser's own resize-loop notice is not the template's error.
    if (!event.error && /ResizeObserver/.test(String(event.message))) return;
    showError(event.error || new Error(String(event.message || "Script error")));
  });
  window.addEventListener("unhandledrejection", (event) => showError(event.reason));
}
