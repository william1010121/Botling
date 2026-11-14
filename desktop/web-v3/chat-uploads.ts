// The chat frame's side of attachments on the Botling 3 page (M2 step 12). Bundled into chat.js after the 2.x chat
// page's entry (web-v3/chat-entry.ts), which it does not edit:
//   - the composer's `+` button (it asks the desktop for a file dialog, `pickFiles`, which a phone does not have) opens
//     this frame's own file input instead (a click caught before the button's own handler);
//   - a picked, pasted or dropped file goes to the shell (`composerHost.upload`, replaced here), which uploads it over
//     the session (web-v3/shell/uploads.ts) and shows it as a chip in the input box;
//   - the shell's progress lines are shown under the composer (one line per upload of the shown bot).
import { composerHost, setComposerHost } from "../../Web/src/composer-host";
import { uploadRowText, type FrameUploadMessage, type ShellUploadMessage, type UploadRow } from "./upload-wire";

function shownBot(): string | undefined {
  return document.documentElement.dataset.chat?.split("/")[0] || undefined;
}

function hand(files: File[]): void {
  const botId = shownBot();
  if (!botId || !files.length) return;
  const message: FrameUploadMessage = { botling3: "upload.add", botId, files };
  window.parent.postMessage(message, "*");
}

let input: HTMLInputElement | null = null;
function fileInput(): HTMLInputElement {
  if (input && input.isConnected) return input;
  input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.hidden = true;
  input.className = "v3-file-input";
  input.setAttribute("aria-hidden", "true");
  input.addEventListener("change", () => {
    const picked = Array.from(input!.files ?? []);
    input!.value = "";
    hand(picked);
  });
  document.body.append(input);
  return input;
}

let rows: UploadRow[] = [];
function renderRows(): void {
  const composer = document.querySelector(".composer");
  let box = document.querySelector<HTMLElement>(".v3-uploads");
  const mine = rows.filter((row) => row.botId === shownBot() && row.state !== "done");
  if (!mine.length || !composer) { box?.remove(); return; }
  if (!box) {
    box = document.createElement("div");
    // The 2.x composer's own status line look (composer-transport.ts), as a second line of it.
    box.className = "composer-upload-status v3-uploads";
    box.setAttribute("role", "status");
    box.setAttribute("data-testid", "uploads");
  }
  if (box.parentElement !== composer) composer.append(box);
  box.replaceChildren(...mine.map((row) => { const line = document.createElement("div"); line.textContent = uploadRowText(row); return line; }));
}

export function installChatUploads(): void {
  // Files from paste, drop and the picker go to the shell.
  setComposerHost({ ...(composerHost ?? {}), upload: (file: File) => hand([file]) } as NonNullable<typeof composerHost>);
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (!target?.closest?.("button.plus")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    fileInput().click();
  }, true);
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data as ShellUploadMessage | null;
    if (!data || typeof data !== "object" || data.botling3 !== "uploads" || !Array.isArray(data.items)) return;
    rows = data.items;
    renderRows();
  });
  // The shown bot changes without a message from the shell: redraw on any change of `data-chat`.
  new MutationObserver(renderRows).observe(document.documentElement, { attributes: true, attributeFilter: ["data-chat"] });
}
