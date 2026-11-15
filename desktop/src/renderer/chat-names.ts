// The names the shell and the chat plugin (plugins/chat/index.ts) agree on (M7-06a). Pure: the shell reads them without importing the
// plugin's module (that one runs only through the trusted loader). Not the `:chat` surface of renderer-kernel.ts (the stand-in that
// provides composer.insertQuote): this is the built-in plugin `botling.chat` that owns the chat's menus and views.

export const CHAT_PLUGIN = "botling.chat";

/** The chat's menus, by their new names (the kernel finds them under the 2.x ids `menu/message/context`, … too). */
export const CHAT_MENUS = ["message/context", "message/preview", "chat/link", "composer/plus"] as const;
export type ChatMenu = (typeof CHAT_MENUS)[number];

/**
 * The chat's view slots: the composer bar (2.x `view/composerBar`), the chat header (2.x `view/chatHeader`) and the main area's tabs (2.x
 * `view/mainTab`). The header's buttons (ChatHeaderViews.tsx) and the bar's one view (ComposerBar.ts `useComposerBarView`) are drawn from the
 * first two (M7-06b, chat-slot.ts `slotViews`); the tab switch beside Chat and Storage from `main/tab` (M7-07a, chat-slot.ts `chatMainTabs`).
 */
export const CHAT_VIEW_SLOTS = ["composer/bar", "chat/header", "main/tab"] as const;

/** The shell's line where the chat column would be, while the plugin is refused, failed or unloaded (07c's fallback screen replaces it). */
export const CHAT_UNAVAILABLE = "Chat is unavailable.";

/** Every slot `botling.chat` provides. */
export const CHAT_SLOTS: readonly string[] = [...CHAT_MENUS, ...CHAT_VIEW_SLOTS];
