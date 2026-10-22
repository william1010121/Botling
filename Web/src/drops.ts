/**
 * Files dropped anywhere on the chat are attached; while files are dragged over it, `body` gets
 * the `dropping` class (a dashed outline around the window).
 *
 * The outline must never outlive the drag. A part of the page may take the drop itself and stop
 * it (the report box's pictures), the drag may leave the window or be cancelled, and WebKit does
 * not always tell the page: so it also clears on any drop or dragend (heard first, on the
 * window), on leaving the window, on the window losing focus, on the mouse moving with no button
 * held (a drag is over by then), and when no dragover has come for a while (one comes every few
 * hundred ms while a drag is over the page, even standing still).
 */
export const dropOutlineIdleMs = 1200;

export function watchFileDrops(body: HTMLElement, onFile: (file: File) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    body.classList.remove("dropping");
  };
  const carriesFiles = (event: Event) => (event as DragEvent).dataTransfer?.types?.includes("Files") === true;

  const over = (event: Event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    body.classList.add("dropping");
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(clear, dropOutlineIdleMs);
  };
  const leave = (event: Event) => {
    const to = (event as DragEvent).relatedTarget as Node | null;
    if (!to || !body.contains(to)) clear();
  };
  const drop = (event: Event) => {
    const files = (event as DragEvent).dataTransfer?.files;
    if (!files?.length) return;
    event.preventDefault();
    for (const file of files) onFile(file);
  };
  const moved = (event: Event) => {
    if ((event as MouseEvent).buttons === 0 && body.classList.contains("dropping")) clear();
  };

  body.addEventListener("dragover", over);
  body.addEventListener("dragleave", leave);
  body.addEventListener("drop", drop);
  // Capture on the window: heard even when the part that takes the drop stops it.
  window.addEventListener("drop", clear, true);
  window.addEventListener("dragend", clear, true);
  window.addEventListener("blur", clear);
  window.addEventListener("mousemove", moved, true);
  return () => {
    clear();
    body.removeEventListener("dragover", over);
    body.removeEventListener("dragleave", leave);
    body.removeEventListener("drop", drop);
    window.removeEventListener("drop", clear, true);
    window.removeEventListener("dragend", clear, true);
    window.removeEventListener("blur", clear);
    window.removeEventListener("mousemove", moved, true);
  };
}
