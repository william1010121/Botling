// The site-tool format, for bots: written to the tools folder as README.md (site-tools.ts) so a bot asked to make a
// tool can read it next to the tools it writes. Keep it in step with browser-site-tools.ts.
export const SITE_TOOLS_GUIDE_TEXT = `# Botling site tools

Small scripts that act on a page in Botling's browser pane (the puzzle button in its toolbar). One folder per tool
in this folder:

    <this folder>/<tool-id>/tool.json
    <this folder>/<tool-id>/script.js

## Who makes them

Site tools are made and kept by Maintainer, so every bot reuses the same tools. Other bots never write in this
folder (the app refuses it): they end their reply with \`<plugin>site tool: what it should do, on which page (its
URL)</plugin>\` and Maintainer builds or widens a tool. Maintainer works in this order:

1. Save the target page's HTML locally first (\`app_browser_extract\` on the page open in Botling's browser, or
   save the page) and build and test the tool against that saved copy, not against guesses about the markup.
2. Try it on the real page in Botling's browser and fix what differs.
3. Finish with a screenshot of the tool working on the real page. A tool is not done without that screenshot.

## Files

The tool id is the folder name: lowercase letters, digits and dashes (\`hn-export\`). The app loads a tool as soon as
its files are saved and shows it on the sites it matches; a broken tool is listed at the bottom of the sheet with
the reason. A folder named like a built-in (\`reader-layout\`, \`chatgpt-export\`) replaces it.

## tool.json

\`\`\`json
{
  "name": "Export conversation",
  "description": "Saves the conversation on this page as a file.",
  "matches": ["https://chatgpt.com/*"],
  "kind": "action",
  "runLabel": "Export",
  "fields": [
    { "id": "format", "label": "Format", "type": "choice", "options": ["Markdown", "JSON"], "default": "Markdown" }
  ]
}
\`\`\`

- \`name\` (1–80 characters), \`description\` (optional, ≤ 400).
- \`matches\`: 1–20 URL patterns. \`<all_urls>\`, or \`scheme://host/path\`: scheme \`http\`, \`https\` or \`*\`;
  host \`*\`, \`*.example.com\` (the domain and its subdomains), \`example.com\` or \`localhost:3000\`; the path may
  hold \`*\` anywhere and is matched against path + query (\`https://news.ycombinator.com/item*\`).
- \`kind\`: \`"action"\` (default: a Run button, and a form when it has fields) or \`"toggle"\` (a switch; while it
  is on for a site the script runs again on every page load there, with \`botling.active\` true; turning it off
  runs it once with \`botling.active\` false so it can undo what it did). A toggle tool has no fields.
- \`runLabel\`: the Run button's text (≤ 24, default "Run").
- \`fields\` (at most 8): \`{ "id", "label", "type": "choice", "options": [2–6 texts], "default" }\`,
  \`{ "id", "label", "type": "text", "default", "placeholder" }\` or \`{ "id", "label", "type": "check", "default": false }\`.

## script.js

The body of an async function (\`await\` and \`return\` work). It runs in an isolated world of the page: it sees and
changes the page's DOM, but not the page's own JavaScript variables, and has no Node, no Botling and no network
powers beyond what any page script has (\`fetch\` is the page's, with its cookies). It gets one object, \`botling\`:

| | |
|---|---|
| \`botling.options\` | the form's values by field id (\`{ format: "Markdown" }\`) |
| \`botling.active\` | toggle tools: true to turn on, false to turn off; null for action tools |
| \`botling.url\` | the page's address |
| \`botling.progress(text)\` | a progress line shown while it runs |
| \`botling.result(text)\` | the line shown when it is done (≤ 2,000 characters) |
| \`botling.saveFile(name, content, type?)\` | saves a file; Botling asks the person where (a save dialog). At most 5 per run, 20 MB each; \`name\` must end in .md, .txt, .json, .csv, .tsv, .html or .xml |
| \`botling.setActive(on)\` | a toggle tool turns itself on or off for the site |

Throw an \`Error\` to show a failure (its message is shown). A run stops after 60 seconds.

Keep it small and defensive: sites change their markup, so look for stable attributes (\`[data-testid]\`,
\`[role]\`, \`article\`) and fail with a clear message when nothing is found. A toggle tool should add one element
or style with a fixed id and remove it when \`botling.active\` is false. Some sites forbid inline \`<style>\` (their
Content-Security-Policy); a constructed sheet still works:
\`const sheet = new CSSStyleSheet(); sheet.replaceSync("…"); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];\`

## Example: a toggle that hides a site's sidebar

tool.json:

\`\`\`json
{ "name": "Hide sidebar", "matches": ["https://example.com/*"], "kind": "toggle" }
\`\`\`

script.js:

\`\`\`js
const ID = "my-hide-sidebar";
document.getElementById(ID)?.remove();
if (!botling.active) return;
const style = document.createElement("style");
style.id = ID;
style.textContent = "aside, [role=complementary] { display: none !important; }";
document.head.append(style);
\`\`\`
`;
