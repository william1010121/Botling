/** Find a chat row, mounting older history first when a navigation target needs it. */
export function findMessageRow(id: string): HTMLElement | null {
  const find = () => document.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(id)}"]`);
  const row = find();
  if (row) return row;
  document.dispatchEvent(new CustomEvent("ccb-reveal-message", { detail: id }));
  return find();
}
