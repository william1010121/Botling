// Copy and paste in the in-app browser pane's pages (2026-11-13), web pages and PDF tabs alike.
//
// The pages are WebContentsViews beside the chat. The app menu's Edit roles (⌘C, ⌘V, …) do not reach them: the copy
// went to the app's own page or nowhere, and Electron gives a page no right-click menu of its own. So each pane page
// runs the edit keys itself (before the page and the app menu see them: `before-input-event`), and its right-click
// shows Cut / Copy / Paste / Select All, plus Copy Link Address and Copy Image when it is over one. The chat's own
// copy and paste are untouched: this is wired only on the pane's pages.
//
// No Electron import here: browser-host.ts passes the page and builds the native menu.

export type EditCommand = "copy" | "cut" | "paste" | "pasteAndMatchStyle" | "selectAll" | "undo" | "redo";

/** What this needs of a page's WebContents. */
export interface EditablePage {
  on(event: "before-input-event", listener: (event: { preventDefault(): void }, input: EditKeyInput) => void): unknown;
  on(event: "context-menu", listener: (event: unknown, params: PageMenuParams) => void): unknown;
  copy(): void; cut(): void; paste(): void; pasteAndMatchStyle(): void; selectAll(): void; undo(): void; redo(): void;
  copyImageAt(x: number, y: number): void;
  isDestroyed(): boolean;
}

export interface EditKeyInput { type: string; key: string; meta: boolean; control: boolean; alt: boolean; shift: boolean }

/** The part of Electron's context-menu params this reads. */
export interface PageMenuParams {
  x: number; y: number;
  isEditable: boolean; selectionText: string; linkURL: string; hasImageContents: boolean; mediaType: string;
  editFlags: { canUndo: boolean; canRedo: boolean; canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
}

export interface PageMenuItem { label: string; enabled: boolean; accelerator?: string; run(): void }
export type PageMenuEntry = PageMenuItem | "separator";

/** The edit command a key press is (⌘ on macOS, Ctrl elsewhere, no other modifier but Shift); null for any other key. */
export function editCommandFor(input: EditKeyInput, platform: NodeJS.Platform | string): EditCommand | null {
  if (input.type !== "keyDown" || input.alt) return null;
  const mac = platform === "darwin";
  const command = mac ? input.meta && !input.control : input.control && !input.meta;
  if (!command) return null;
  const key = input.key.toLowerCase();
  if (input.shift) {
    if (key === "z") return "redo";
    if (key === "v") return "pasteAndMatchStyle";
    return null;
  }
  switch (key) {
    case "c": return "copy";
    case "x": return "cut";
    case "v": return "paste";
    case "a": return "selectAll";
    case "z": return "undo";
    case "y": return mac ? null : "redo";
    default: return null;
  }
}

function runCommand(page: EditablePage, command: EditCommand) {
  if (page.isDestroyed()) return;
  page[command]();
}

/** The right-click menu for where the user clicked on a page; `writeText` puts a link on the clipboard. */
export function pageMenuItems(params: PageMenuParams, page?: EditablePage, writeText?: (text: string) => void, platform: string = process.platform): PageMenuEntry[] {
  const mod = platform === "darwin" ? "Cmd" : "Ctrl";
  const flags = params.editFlags;
  const run = (command: EditCommand) => () => { if (page) runCommand(page, command); };
  const groups: PageMenuItem[][] = [];
  if (params.isEditable) {
    groups.push([
      { label: "Undo", enabled: flags.canUndo, accelerator: `${mod}+Z`, run: run("undo") },
      { label: "Redo", enabled: flags.canRedo, accelerator: `Shift+${mod}+Z`, run: run("redo") },
    ]);
    groups.push([
      { label: "Cut", enabled: flags.canCut, accelerator: `${mod}+X`, run: run("cut") },
      { label: "Copy", enabled: flags.canCopy, accelerator: `${mod}+C`, run: run("copy") },
      { label: "Paste", enabled: flags.canPaste, accelerator: `${mod}+V`, run: run("paste") },
    ]);
  } else if (params.selectionText.trim()) {
    groups.push([{ label: "Copy", enabled: flags.canCopy, accelerator: `${mod}+C`, run: run("copy") }]);
  }
  const extra: PageMenuItem[] = [];
  if (params.linkURL) extra.push({ label: "Copy Link Address", enabled: true, run: () => writeText?.(params.linkURL) });
  if (params.hasImageContents && params.mediaType === "image") {
    extra.push({ label: "Copy Image", enabled: true, run: () => { if (page && !page.isDestroyed()) page.copyImageAt(params.x, params.y); } });
  }
  if (extra.length) groups.push(extra);
  groups.push([{ label: "Select All", enabled: flags.canSelectAll, accelerator: `${mod}+A`, run: run("selectAll") }]);
  return groups.flatMap((group, index) => index ? ["separator" as const, ...group] : group);
}

export interface PageEditingOptions {
  platform: NodeJS.Platform | string;
  /** Shows the right-click menu (browser-host.ts builds the native one). */
  popup(items: PageMenuEntry[], params: PageMenuParams): void;
  writeText(text: string): void;
}

/** The edit keys and the right-click menu, on one pane page. */
export function wirePageEditing(page: EditablePage, options: PageEditingOptions): void {
  page.on("before-input-event", (event, input) => {
    const command = editCommandFor(input, options.platform);
    if (!command) return;
    event.preventDefault();
    runCommand(page, command);
  });
  page.on("context-menu", (_event, params) => {
    options.popup(pageMenuItems(params, page, options.writeText, options.platform), params);
  });
}
