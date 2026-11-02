# Built-in plugins

The first-party plugins shipped with Botling (plugin-platform.md §3.4, step M11). Each folder is a plugin
as the plugin library holds one (`package.json` with a `ccb` field), and the registry loads it by the same
path: `build-builtin-plugins.mjs` builds them into `out/builtin-plugins/`, and electron-builder copies that
beside app.asar (`Botling 2.app/Contents/Resources/builtin-plugins`). They are read-only, on until you turn
one off in the Plugins page, and never wait for approval. A plugin of the same name in the library replaces
one, which is how Maintainer changes a built-in plugin: it copies the folder into the library.

| Plugin | What it brings |
|---|---|
| `ccb-latex` | KaTeX in messages and the input box (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`), Mod+Shift+M. Botling Web (the phone, which runs no plugins) bundles its web part into the chat page instead. |
| `botling.cards` | The web preview card (`網頁預覽卡片`). A component of the same name in the library (`ccb-components`) still wins. |
| `botling.chat-extras` | Pictures in a row of a reply become one gallery, a long message of yours folds to its first lines (Show more), and a long paste waits as a chip above the input box (its limits are this plugin's settings; the ones Botling's own settings had move here once). Botling Web bundles its web part, as ccb-latex's. |
| `botling.design` | `/design` in the / menu, put into the message as words; the bots' rules say what it means. |
| `botling.catchup` | Chat summaries: unread replies folded into a summary card when you read a chat (`chatRead`), intervals between your messages, sources in a dialog. Its program part reads the chat (`chat.messages`), runs the isolated claude/codex one-shot call (`engines.cli`) and puts each summary in the chat as a message decoration (`chat.decorate`), which its web part draws (`ccb.decorations`, Web/src/decorations.ts). Its settings show under Settings → General → Chat summaries (`hidden` on the Plugins page). The first run takes over the core's old `catchup-summaries.json` and settings.json keys without changing them. Botling Web bundles its web part, as it does ccb-latex's. |
| `botling.usage` | The quota rings in the sidebar gear's popover (Claude, Codex, Antigravity; `quickSettings` view) and Settings → Usage (`settings.section` view, with the "Usage by bot" link in the popover). Botling still collects the numbers (`core/usage.ts`, `quota.ts`); the plugin reads them with `api.usage.view()` through its program part and draws them in two sandboxed frames, refreshing on open, after a bot's turn (its program part counts `turnFinished`), and each minute. |

The `choices` card is not here: the chat draws a reply's `<choices>` as buttons by itself, and a `choices`
component in the library replaces them, as before. Shipping a template here would change how questions look
for everyone without one.
