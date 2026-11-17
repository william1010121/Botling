// What the web part borrows from the chat page it runs in (`ccb` at activate; tests set their own): the
// chat's own Markdown and media drawing.

export interface Page {
  render(text: string): string;
  media(url: string, label: string): string;
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const page: Page = {
  render: (text) => `<p>${escape(text)}</p>`,
  media: (url, label) => `<img class="media" src="${escape(url)}" alt="${escape(label)}">`,
};

export function setPage(next: Partial<Page>): void {
  Object.assign(page, next);
}
