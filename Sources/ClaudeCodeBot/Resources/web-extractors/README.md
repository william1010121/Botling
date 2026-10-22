# Web page readers

ClaudeCodeBot shows web AIs (Gemini, ChatGPT, Claude) as bots in the left column, in a real web view. After the
page settles (an answer has finished), the app runs this plugin's script for that site to read
the conversation as text, and saves it to `~/.claudecodebot/web/<site>/<name>.md` for the main bot
to search. While the page still changes it also runs it about once a second, only to see a
question you just sent (the last turn yours, no answer yet), so that question is listed at once.

This folder belongs to Maintainer. When a site changes its page and the app says
"Couldn't read this page", fix that site's script here. The app keeps its own copy of each
script as a fallback and only updates a file here while nobody has edited it.

## One script per site

`<site id>.js`: `gemini.js`, `chatgpt.js`, `claude.js`. The site id is the folder name under `web/`.
`chatgpt.js` and `claude.js` differ only in their `SELECTORS`; the part below `extract`
(the page as Markdown) is the same in both, so a fix to it goes in both.

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
    `[{ role: "user" | "assistant", text: "the message" }, ...]`. The text is Markdown where the
    page has structure (lists, code blocks, tables), with a formula as its TeX (`$…$`, `$$…$$`
    on its own line), never KaTeX's drawn text.
  - An answer still being written is left out, so the question before it still waits.
  - `{ error: "why" }` when the page cannot be read.
  - No turns (or only empty ones) counts as nothing read: the app shows "Couldn't read this page"
    and writes no file.
- **Read only**: never type, click, scroll, submit or change the page; no network requests.
- It must be synchronous and quick (it runs again each time the page settles, and about once a
  second while a new question waits for its first read).
- A thrown error is caught and shown the same way as `{ error }`.

Keep the page-specific parts (CSS selectors) together at the top of the script so they are easy
to fix.

## Reading the traffic too (optional)

The app also watches the page's own traffic (fetch, XHR, EventSource and WebSocket, as the page
reads them; never a request of its own) and keeps the last 5 minutes in memory. A script may
read the conversation from it as well, beside `extract(doc)`:

```js
// The requests it reads (regular expressions, or plain text, matched against each URL).
const NETWORK = { urls: ["/StreamGenerate", "rpcids=hNvQHb"] };

function extractNetwork(exchanges, context) { ... }
```

- **Input**: `exchanges`, the matching requests in the order they went out, each
  `{ id, kind: "fetch"|"xhr"|"sse"|"ws", method, url, status, requestHeaders, responseHeaders,
  contentType, requestBody, responseBody, messages: [{ dir: "in"|"out", data, t }], startedAt,
  endedAt, done, note }` (`responseBody` is every piece of the answer joined; an EventSource's
  events and a WebSocket's messages are in `messages`). `context` is
  `{ site, url, conversationID }` (the id is null on a new question's page). The minutes kept may
  hold other conversations: use `context` to pick this one.
- **Output**: `{ title, turns }` as `extract` gives, `null` when the traffic holds nothing about
  this conversation, or `{ error }`.
- It runs only once the page settles. The app then compares the two readings: when every message
  one found the other found too, the traffic's text is saved (it is the site's own Markdown);
  when they differ, the page's text is saved and the app shows "Page reader may be out of date"
  with a Re-capture button.

## Captures and tests

The Capture button over the page records the page and its traffic into a private folder,
`~/.claudecodebot/captures/<site>/<time>/` (the newest 5 per site are kept, none older than 30
days; never commit or share them): `manifest.json`, `events.jsonl` (every request and piece of an
answer, in time order), `network.har`, `dom.html` (inline scripts removed), `outline.json` (the
visible elements, for selectors), `screenshot.png`, `extractor/` (the script then and what it
read) and, once written, `expected.json`:

```json
{ "title": "…", "turns": [{ "role": "user", "text": "…" }], "confirmed": false }
```

Maintainer writes `expected.json` from the screenshot; the user confirms it on a card in the app.
Cookies, sign-in tokens, CSRF values, e-mail addresses and account ids are masked before anything
is written; the screenshot is not.

`ClaudeCodeBot --test-extractor <capture, a site's captures folder, or the captures folder>
[--extractor <file.js>]` replays each capture (its `dom.html` with no page scripts and no
network, and its events) through this script exactly as the app runs it, and passes when it reads
`expected.json` and the page and traffic readings agree. Run it on every capture before you commit.
