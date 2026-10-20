/** A picture going with a report, as the Swift side saves it. */
export interface Picture {
  name: string;
  base64: string;
}

/**
 * Lets pictures be pasted (⌘V) into `textarea` or dropped on `box`; each shows as a thumbnail
 * in `strip` with a remove button. Returns the live list; `changed` runs after every change.
 */
export function acceptPictures(box: HTMLElement, textarea: HTMLTextAreaElement, strip: HTMLElement, changed: () => void): Picture[] {
  const images: Picture[] = [];
  const add = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const image = { name: file.name || `Pasted image.${file.type.split("/")[1] ?? "png"}`, base64: url.slice(url.indexOf(",") + 1) };
      images.push(image);
      const item = document.createElement("div");
      item.className = "report-image";
      item.innerHTML = `<img alt=""><button class="remove" aria-label="Remove picture">×</button>`;
      item.querySelector("img")!.src = url;
      item.querySelector("img")!.alt = image.name;
      item.querySelector(".remove")!.addEventListener("click", () => {
        images.splice(images.indexOf(image), 1);
        item.remove();
        strip.hidden = images.length === 0;
        changed();
      });
      strip.append(item);
      strip.hidden = false;
      changed();
    };
    reader.readAsDataURL(file);
  };
  textarea.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    files.forEach(add);
  });
  box.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    box.classList.add("dropping");
  });
  box.addEventListener("dragleave", () => box.classList.remove("dropping"));
  box.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files.length) return;
    // Pictures dropped here go with the report, not into the chat's input box.
    event.preventDefault();
    event.stopPropagation();
    box.classList.remove("dropping");
    [...event.dataTransfer.files].forEach(add);
  });
  return images;
}
