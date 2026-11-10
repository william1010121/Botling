// The site tools that come with the app (browser-site-tools.ts): a reader layout for every site and an export of
// the conversation on chatgpt.com. They are written exactly like a bot's tool, and a folder of the same id in the
// tools folder takes a built-in's place.

export interface BuiltInSiteTool { id: string; manifest: Record<string, unknown>; script: string }

const READER = String.raw`
const ID = "botling-reader-layout";
document.getElementById(ID)?.remove();
if (!botling.active) return;
const pick = document.querySelector("article") || document.querySelector("main, [role=main]") || document.body;
const copy = pick.cloneNode(true);
copy.querySelectorAll("script, style, link, noscript, iframe, nav, aside, footer, form, button, input, select, textarea, svg, canvas, [role=navigation], [role=complementary], [aria-hidden=true], [hidden]").forEach((node) => node.remove());
copy.querySelectorAll("*").forEach((node) => { node.removeAttribute("style"); node.removeAttribute("class"); node.removeAttribute("id"); });
const host = document.createElement("div");
host.id = ID;
for (const [name, value] of [["all", "initial"], ["position", "fixed"], ["inset", "0"], ["z-index", "2147483647"], ["display", "block"]]) host.style.setProperty(name, value, "important");
const shadow = host.attachShadow({ mode: "closed" });
// A constructed style sheet: a site's Content-Security-Policy does not stop it, as it would a <style>.
const sheet = new CSSStyleSheet();
sheet.replaceSync(
  '.page { position: absolute; inset: 0; overflow: auto; background: #fbfaf7; color: #1d1d1f; }' +
  '.text { max-width: 680px; margin: 0 auto; padding: 48px 24px 96px; font: 19px/1.7 Charter, Georgia, "Noto Serif TC", "PingFang TC", serif; }' +
  'h1 { font-size: 32px; line-height: 1.25; margin: 0 0 24px; } h2, h3 { line-height: 1.3; }' +
  'img, video, picture { max-width: 100%; height: auto; } a { color: #2f6fe0; }' +
  'pre, code { font: 14px/1.5 ui-monospace, Menlo, monospace; } pre { white-space: pre-wrap; background: #f0eee8; padding: 12px; border-radius: 8px; }' +
  'table { border-collapse: collapse; } td, th { border: 1px solid #ddd; padding: 4px 8px; }' +
  '@media (prefers-color-scheme: dark) { .page { background: #17171a; color: #e6e6ea; } pre { background: #24242a; } a { color: #7aa7ff; } td, th { border-color: #333; } }');
shadow.adoptedStyleSheets = [sheet];
const page = document.createElement("div");
page.className = "page";
const column = document.createElement("div");
column.className = "text";
column.append(document.createElement("h1"));
page.append(column);
shadow.append(page);
shadow.querySelector("h1").textContent = document.title;
shadow.querySelector(".text").append(copy);
document.documentElement.append(host);
`;

const CHATGPT_EXPORT = String.raw`
const turns = [...document.querySelectorAll("[data-message-author-role]")];
if (!turns.length) throw new Error("No conversation on this page. Open a chat first.");
botling.progress("Reading " + turns.length + " messages…");
function markdown(element) {
  const copy = element.cloneNode(true);
  const blocks = [];
  copy.querySelectorAll("pre").forEach((pre) => {
    const language = ((pre.querySelector("code")?.className || "").match(/language-([\w+-]+)/) || [])[1] || "";
    blocks.push("~~~" + language + "\n" + (pre.querySelector("code") || pre).textContent.replace(/\n$/, "") + "\n~~~");
    pre.replaceWith(document.createTextNode("\n\u0000" + (blocks.length - 1) + "\u0000\n"));
  });
  copy.querySelectorAll("button, svg, [aria-hidden=true]").forEach((node) => node.remove());
  const box = document.createElement("div");
  box.style.cssText = "position: fixed; left: -100000px; top: 0; width: 800px;";
  box.append(copy);
  document.body.append(box);
  const text = box.innerText;
  box.remove();
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => blocks[Number(index)]).replace(/\n{3,}/g, "\n\n").trim();
}
const messages = turns.map((turn) => ({ role: turn.getAttribute("data-message-author-role"), text: markdown(turn) })).filter((message) => message.text);
const title = (document.title || "ChatGPT conversation").replace(/\s*[|·-]\s*ChatGPT\s*$/i, "").trim() || "ChatGPT conversation";
const stem = title.replace(/[^\p{L}\p{N} _-]+/gu, " ").trim().slice(0, 80) || "conversation";
if (botling.options.format === "JSON") {
  botling.saveFile(stem + ".json", JSON.stringify({ title, url: location.href, exported: new Date().toISOString(), messages }, null, 2), "application/json");
} else {
  const names = { user: "You", assistant: "ChatGPT", system: "System", tool: "Tool" };
  const body = messages.map((message) => "## " + (names[message.role] || message.role) + "\n\n" + message.text).join("\n\n");
  botling.saveFile(stem + ".md", "# " + title + "\n\n" + location.href + "\n\n" + body + "\n", "text/markdown");
}
botling.result(messages.length + " messages");
`;

export const BUILT_IN_SITE_TOOLS: readonly BuiltInSiteTool[] = [
  {
    id: "reader-layout",
    manifest: {
      name: "Reader layout",
      description: "Shows the page's text alone, in a calm column.",
      matches: ["<all_urls>"],
      kind: "toggle",
    },
    script: READER,
  },
  {
    id: "chatgpt-export",
    manifest: {
      name: "Export conversation",
      description: "Saves the conversation on this page as a file.",
      matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
      kind: "action",
      runLabel: "Export",
      fields: [{ id: "format", label: "Format", type: "choice", options: ["Markdown", "JSON"], default: "Markdown" }],
    },
    script: CHATGPT_EXPORT,
  },
];
