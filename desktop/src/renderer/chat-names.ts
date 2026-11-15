// The names the shell and the chat plugin (plugins/chat/index.ts) agree on (M7-06a). Pure: the shell reads them without importing the
// plugin's module (that one runs only through the trusted loader). Not the `:chat` surface of renderer-kernel.ts (the stand-in that
// provides composer.insertQuote): this is the built-in plugin `botling.chat` that owns the chat's menus and views.

export const CHAT_PLUGIN = "botling.chat";

/** The chat's menus, by their new names (the kernel finds them under the 2.x ids `menu/message/context`, … too). */
export const CHAT_MENUS = ["message/context", "message/preview", "chat/link", "composer/plus"] as const;
export type ChatMenu = (typeof CHAT_MENUS)[number];

/** The chat's view slots: the composer bar (2.x `view/composerBar`) and the chat header (2.x `view/chatHeader`). Still drawn by the old chat (M7-06b moves them). */
export const CHAT_VIEW_SLOTS = ["composer/bar", "chat/header"] as const;

/** Every slot `botling.chat` provides. */
export const CHAT_SLOTS: readonly string[] = [...CHAT_MENUS, ...CHAT_VIEW_SLOTS];
