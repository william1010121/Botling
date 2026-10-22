# Web page readers

ClaudeCodeBot shows web AIs (Gemini) as bots in the left column, in a real web view. After the
page settles (an answer has finished), the app runs this plugin's script for that site to read
the conversation as text, and saves it to `~/.claudecodebot/web/<site>/<name>.md` for the main bot
to search. While the page still changes it also runs it about once a second, only to see a
question you just sent (the last turn yours, no answer yet), so that question is listed at once.

This folder belongs to Maintainer. When a site changes its page and the app says
"Couldn't read this page", fix that site's script here. The app keeps its own copy of each
script as a fallback and only updates a file here while nobody has edited it.

## One script per site

`<site id>.js`, for example `gemini.js`. The site id is the folder name under `web/`.

## The contract

The script declares a function:

```js
function extract(doc) { ... }
```

- **Input**: `doc` is the page's `document`, read in an isolated world (the page's own scripts
  cannot see the reader, and the reader cannot call theirs).
- **Output**: a plain object the app turns into JSON:
  - `{ title, turns }` where `title` is a string or `null` (the app then uses the tab's title,
    else the first question), and `turns` is the conversation in page order:
    `[{ role: "user" | "assistant", text: "plain text" }, ...]`.
  - `{ error: "why" }` when the page cannot be read.
  - No turns (or only empty ones) counts as nothing read: the app shows "Couldn't read this page"
    and writes no file.
- **Read only**: never type, click, scroll, submit or change the page; no network requests.
- It must be synchronous and quick (it runs again each time the page settles, and about once a
  second while a new question waits for its first read).
- A thrown error is caught and shown the same way as `{ error }`.

Keep the page-specific parts (CSS selectors) together at the top of the script so they are easy
to fix.
