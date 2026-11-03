// The chips under a reply (1.x's spec chips; the chat page's messages.ts before this plugin): a component made from a reply, under it.
// A bot's suggestion is a quiet chip until pressed (then its first version is built); while building the chip says Building…; once built
// the component itself shows, with "Edit spec" to open its spec in the right panel and Undo / Restore (ADR-006 M4). A command it runs asks
// first (Allow and run, with the exact command and folder), as on any card. The program part (desk.ts) says what the chips are
// (`chat.decorate`, one decoration under each reply that has some); this draws them in the reply's own column.
import type { DecorationRenderer } from "../../../../Web/src/decorations";
import type { CcbWeb } from "../../../../Web/src/plugins";
import type { ChatState, SpecChipView } from "./types";
import { t } from "./words";

const cubeIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>`;

/** What the chips ask of their plugin (`ccb.call` and the app's ApprovalSheet). */
export interface ChipIO {
  press(id: string): void;
  open(id: string): void;
  undo(id: string): void;
  restore(id: string): void;
  /** The built component's command (the card's run, ↻ or first draw): asks the program part, then your OK on the sheet if it is not allowed yet. */
  run(chat: string, id: string, request: { command: string; folder: string; detail?: string; force?: boolean }): void;
}

type Draw = CcbWeb["draw"];

function button(className: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.className = className;
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return element;
}

/** Undo (take the component off the bot's list) or Restore (put it back); the library copy and its versions stay. */
function undoButton(spec: SpecChipView, io: ChipIO): HTMLButtonElement {
  const restore = spec.undo === "restore";
  const element = button("spec-edit spec-undo", () => (restore ? io.restore(spec.id) : io.undo(spec.id)));
  element.textContent = t(restore ? "specChip.restore" : "specChip.undo");
  element.title = t(restore ? "specChip.restoreTitle" : "specChip.undoTitle");
  return element;
}

function editButton(spec: SpecChipView, io: ChipIO): HTMLButtonElement {
  const element = button("spec-edit", () => io.open(spec.id));
  element.textContent = t("specChip.edit");
  element.setAttribute("aria-expanded", String(spec.open));
  element.title = spec.open ? t("specChip.showing") : t("specChip.editTitle");
  return element;
}

/** A built component under its reply: its name, Edit spec, and the component itself. */
function builtSpec(spec: SpecChipView, state: ChatState, chat: string, draw: Draw, io: ChipIO): HTMLElement | null {
  const display = spec.display!;
  const name = spec.component!;
  const card = draw.component({
    name, info: state.components?.[name], display, key: `spec-${spec.id}`, cardKey: `spec:${spec.id}`, lazy: true,
    send: (request) => io.run(chat, spec.id, request),
  });
  if (!card) return null;
  const box = document.createElement("div");
  box.className = `spec-built ${spec.status}${spec.open ? " open" : ""}`;
  const head = document.createElement("div");
  head.className = "spec-built-head";
  const label = document.createElement("span");
  label.className = "spec-built-name";
  label.innerHTML = spec.status === "building" ? `<span class="spinner" aria-hidden="true"></span><span></span>` : `${cubeIcon}<span></span>`;
  label.querySelector("span:not(.spinner)")!.textContent = spec.status === "building" ? t("specChip.newVersion", { name }) : `${t("specChip.component")} · ${name}`;
  head.append(label, editButton(spec, io), ...(spec.status === "done" && spec.undo === "undo" ? [undoButton(spec, io)] : []));
  // The Board plugin may add a button (its pin: a bot-filled one is made live on the Board, Maintainer gives it a command).
  if (spec.status === "done") {
    const added = draw.pinButton(spec);
    if (added) head.append(added);
  }
  box.append(head, card);
  return box;
}

/** The chips of one reply, as a strip. */
export function specChips(specs: SpecChipView[], state: ChatState, chat: string, draw: Draw, io: ChipIO): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "spec-chips";
  for (const spec of specs) {
    const built = spec.component && spec.display ? builtSpec(spec, state, chat, draw, io) : null;
    if (built) {
      strip.append(built);
      continue;
    }
    const chip = button(`spec-chip ${spec.status}${spec.suggested ? " suggested" : ""}${spec.open ? " open" : ""}`, () => io.press(spec.id));
    chip.setAttribute("aria-expanded", String(spec.open));
    // Built, and the bot that wrote the reply is drawing it for the reply.
    const filling = spec.status === "done" && spec.filling ? spec.filling : null;
    const building = spec.status === "building" || !!filling;
    const words = filling ? t("specChip.filling", { bot: filling }) : spec.status === "done" ? t("specChip.component") : building ? t("specChip.building") : spec.suggested ? t("specChip.suggested") : t("specChip.spec");
    chip.innerHTML = `${building ? `<span class="spinner" aria-hidden="true"></span>` : cubeIcon}<span></span><span class="spec-chip-arrow" aria-hidden="true">›</span>`;
    chip.querySelector("span:not(.spinner)")!.textContent = `${words} · ${spec.component ?? spec.name}`;
    chip.title = filling ? t("specChip.fillingTitle", { bot: filling }) : spec.suggested ? t("specChip.suggestedTitle") : building ? t("specChip.buildingTitle") : spec.open ? t("specChip.showing") : t("specChip.openInPanel");
    strip.append(chip);
    if (spec.undo === "restore") strip.append(undoButton(spec, io));
    else if (spec.status === "done") strip.append(editButton(spec, io), ...(spec.undo === "undo" ? [undoButton(spec, io)] : []));
  }
  return strip;
}

/** The renderer for this plugin's decorations: each is the chips under one reply (`data.specs`), drawn in that reply's column. */
export function chipRenderer(draw: Draw, io: ChipIO): DecorationRenderer {
  /** The row and column each decoration widened, to give them back when it goes. */
  const widened = new Map<string, { row: HTMLElement; column: HTMLElement }>();
  return {
    draw(root, decoration, context) {
      const specs = ((decoration.data as { specs?: SpecChipView[] } | null)?.specs ?? []) as SpecChipView[];
      const strip = specChips(specs, context.state, context.state.botID, draw, io);
      // Under the words of a reply the chat draws: a component made from it takes the whole column, as one in the reply does.
      const column = root.parentElement;
      const row = column?.closest<HTMLElement>(".row");
      const built = !!strip.querySelector(".spec-built");
      root.replaceChildren(strip);
      root.classList.add("spec-decoration");
      if (column && row) {
        const wide = built || !!column.querySelector(":scope > .bubble.wide");
        column.classList.toggle("wide", wide);
        row.classList.toggle("wide", wide);
        column.classList.toggle("tiled", built);
        widened.set(decoration.key, { row, column });
      }
    },
    removed(decoration) {
      // Its tile is gone: the reply is as wide as its own words say (a card in them keeps it wide).
      const kept = widened.get(decoration.key);
      widened.delete(decoration.key);
      if (!kept?.column.isConnected) return;
      const wide = !!kept.column.querySelector(":scope > .bubble.wide");
      kept.column.classList.toggle("wide", wide);
      kept.row.classList.toggle("wide", wide);
      kept.column.classList.remove("tiled");
    },
  };
}
