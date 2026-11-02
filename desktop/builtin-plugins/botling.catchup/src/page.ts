// What the web part borrows from the chat page it runs in (`ccb` at activate; tests set their own): the
// chat's own Markdown and media drawing, its task chips, and its call to this plugin's program part.
import type { TaskCardView } from "../../../../Web/src/types";

export interface Page {
  render(text: string): string;
  media(url: string, label: string): string;
  taskChip(task: TaskCardView, action?: string): string;
  call(method: string, params?: unknown): Promise<unknown>;
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const page: Page = {
  render: (text) => `<p>${escape(text)}</p>`,
  media: (url, label) => `<img class="media" src="${escape(url)}" alt="${escape(label)}">`,
  taskChip: (task) => `<button type="button" class="task-card-chip ${escape(task.state)}" data-task-id="${escape(task.id)}">${escape(task.name)}</button>`,
  call: () => Promise.reject(new Error("Not in the chat page.")),
};

export function setPage(next: Partial<Page>): void {
  Object.assign(page, next);
}
