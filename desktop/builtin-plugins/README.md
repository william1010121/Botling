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
| `botling.design` | `/design` in the / menu, put into the message as words; the bots' rules say what it means. |

The `choices` card is not here: the chat draws a reply's `<choices>` as buttons by itself, and a `choices`
component in the library replaces them, as before. Shipping a template here would change how questions look
for everyone without one.
