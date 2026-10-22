// FIXTURE pages for testing web capture (`ClaudeCodeBot --capture-test`), NOT copies of the real
// sites. Each page mimics, as far as we know them, how its site talks to its server and draws a
// conversation: Gemini's XHR StreamGenerate (length-prefixed `wrb.fr` frames) and batchexecute
// history, ChatGPT's conversation JSON and SSE answer, Claude's chat_conversations JSON, SSE
// completion and an EventSource. The page draws what its traffic said in the site's markup, so
// the page reader and the traffic reader can be compared. Sign-in secrets (a cookie, a bearer
// token, a CSRF header, the `at` form token, an e-mail, an org id) are sent on purpose, to check
// they are masked in the capture.
//
//   node server.mjs [port]      then open http://127.0.0.1:<port>/app/fixture0001 (Gemini),
//                               /c/fixture-0002 (ChatGPT), /chat/fixture-0003 (Claude);
//                               ?variant=stale draws an older answer than the traffic has.
import { createServer } from "node:http";

const port = Number(process.argv[2] || 8765);
const ORG = "0b5e2a8c-1d2f-4e3a-9b7c-5d6e7f8a9b0c";
const EMAIL = "fixture.user@example.com";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlLXVzZXIiLCJlbWFpbCI6ImZpeHR1cmUifQ.c2lnbmF0dXJlLWZpeHR1cmUtdmFsdWU";
const AT_TOKEN = "AFixtureXsrfToken0123456789:1792655000000";

const TITLE = "Hash table load factor";
const Q1 = "Why is a hash table O(1) on average?";
const A1 = "Each slot holds about **n/m** keys on average.\n\n- Hash the key.\n- Probe until a match.";
const Q2 = "And in the worst case?";
const A2 = "Every key can land in one slot, so a lookup is **O(n)** in the worst case.";
const pieces = (text) => text.match(/.{1,18}/gs);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the page (the same script for each site; `SITE` picks its traffic and markup) ----
const page = (site, id, variant) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${site === "chatgpt" ? "ChatGPT" : site === "claude" ? "Claude" : "Gemini"}</title>
<style>body{font:15px -apple-system,sans-serif;margin:0;background:#fff;color:#222}nav{position:fixed;left:0;top:0;bottom:0;width:220px;background:#f3f3f3;padding:16px}main{margin-left:252px;padding:24px;max-width:720px}.u{background:#eef;border-radius:12px;padding:8px 12px;margin:12px 0}.a{padding:4px 0 12px}</style>
</head><body>
<nav id="nav"></nav><main id="main"></main>
<script>
const SITE = ${JSON.stringify(site)}, ID = ${JSON.stringify(id)}, STALE = ${variant === "stale"}, ORG = ${JSON.stringify(ORG)};
const Q2 = ${JSON.stringify(Q2)};
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const inline = (s) => esc(s).replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>");
const html = (md) => md.split(/\\n\\n+/).map((block) => block.split("\\n").every((l) => l.startsWith("- "))
  ? "<ul>" + block.split("\\n").map((l) => "<li>" + inline(l.slice(2)) + "</li>").join("") + "</ul>"
  : "<p>" + inline(block) + "</p>").join("");
const main = document.getElementById("main");
function title(text) {
  const nav = document.getElementById("nav");
  if (SITE === "gemini") nav.innerHTML = '<div class="conversation selected"><div class="conversation-title">' + esc(text) + '</div></div>';
  if (SITE === "chatgpt") nav.innerHTML = '<a href="/c/' + ID + '" aria-current="page"><div class="truncate">' + esc(text) + '</div></a>';
  if (SITE === "claude") nav.innerHTML = '<button data-testid="chat-menu-trigger">' + esc(text) + '</button>';
}
// One message drawn in the site's markup; returns a function that redraws its answer's text.
function draw(role, md, streaming) {
  const box = document.createElement("div");
  if (SITE === "gemini") {
    box.innerHTML = role === "user"
      ? '<user-query class="u"><div class="query-text"><p class="query-text-line">' + esc(md) + '</p></div></user-query>'
      : '<model-response class="a"><message-content><div class="markdown"></div></message-content></model-response>';
  } else if (SITE === "chatgpt") {
    box.innerHTML = role === "user"
      ? '<article data-turn="user" class="u"><div data-message-author-role="user"><div class="whitespace-pre-wrap">' + esc(md) + '</div></div></article>'
      : '<article data-turn="assistant" class="a"><div data-message-author-role="assistant"><div class="markdown' + (streaming ? ' result-streaming' : '') + '"></div></div></article>';
  } else {
    box.innerHTML = role === "user"
      ? '<div data-testid="user-message" class="u"><p class="whitespace-pre-wrap">' + esc(md) + '</p></div>'
      : '<div data-is-streaming="' + (streaming ? "true" : "false") + '" class="a"><div class="standard-markdown"></div></div>';
  }
  main.appendChild(box);
  const body = box.querySelector(".markdown, .standard-markdown");
  const set = (text, done) => {
    if (!body) return;
    body.innerHTML = html(STALE && role === "assistant" ? "An older layout drew this answer instead." : text);
    if (done && SITE === "chatgpt") body.classList.remove("result-streaming");
    if (done && SITE === "claude") box.firstChild.setAttribute("data-is-streaming", "false");
  };
  if (role === "assistant") set(md, !streaming);
  return set;
}
const xhr = (method, url, body, headers, onText) => new Promise((resolve) => {
  const request = new XMLHttpRequest();
  request.open(method, url);
  for (const [k, v] of Object.entries(headers || {})) request.setRequestHeader(k, v);
  let seen = 0;
  request.onprogress = () => { onText && onText(request.responseText.slice(seen)); seen = request.responseText.length; };
  request.onload = () => { if (request.responseText.length > seen) onText && onText(request.responseText.slice(seen)); resolve(request.responseText); };
  request.send(body);
});
async function sse(response, onEvent) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at;
    while ((at = buffer.indexOf("\\n\\n")) >= 0) {
      const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
      const data = block.split("\\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\\n");
      const event = (block.split("\\n").find((l) => l.startsWith("event: ")) || "event: message").slice(7);
      onEvent(event, data);
    }
  }
}
async function gemini() {
  const history = await xhr("POST", "/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&source-path=%2Fapp%2F" + ID + "&bl=boq_fixture&f.sid=-123456789&hl=en&_reqid=100&rt=c",
    "f.req=" + encodeURIComponent(JSON.stringify([[["hNvQHb", JSON.stringify(["c_" + ID, 10]), null, "generic"]]])) + "&at=" + encodeURIComponent(${JSON.stringify(AT_TOKEN)}) + "&",
    { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "X-Same-Domain": "1" });
  const frame = JSON.parse(history.slice(history.indexOf("\\n[") + 1).split("\\n")[0]);
  const turns = JSON.parse(frame[0][2])[0];
  title(${JSON.stringify(TITLE)});
  for (const turn of turns.slice().reverse()) { draw("user", turn[2][0][0]); draw("assistant", turn[3][0][0][1][0]); }
  await new Promise((r) => setTimeout(r, 400));
  draw("user", Q2);
  const set = draw("assistant", "", true);
  let raw = "";
  await xhr("POST", "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq_fixture&f.sid=-123456789&hl=en&_reqid=200&rt=c",
    "f.req=" + encodeURIComponent(JSON.stringify([null, JSON.stringify([[Q2, 0, null, null, null, null, 0], ["en"], ["c_" + ID, "r_fixture", "rc_fixture"]])])) + "&at=" + encodeURIComponent(${JSON.stringify(AT_TOKEN)}) + "&",
    { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "X-Same-Domain": "1" },
    (text) => {
      raw += text;
      const frames = raw.split("\\n").filter((l) => l.startsWith("[["));
      if (!frames.length) return;
      const inner = JSON.parse(JSON.parse(frames[frames.length - 1])[0][2]);
      set(inner[4][0][1][0], false);
    });
}
async function chatgpt() {
  await (await fetch("/api/auth/session")).json();
  const token = "Bearer ${JWT}";
  const conversation = await (await fetch("/backend-api/conversation/" + ID, { headers: { authorization: token, "oai-device-id": "device-fixture-1234" } })).json();
  title(conversation.title);
  let node = conversation.mapping[conversation.current_node];
  const chain = [];
  while (node) { if (node.message) chain.unshift(node.message); node = conversation.mapping[node.parent]; }
  for (const message of chain) draw(message.author.role, message.content.parts.join(""));
  await new Promise((r) => setTimeout(r, 400));
  draw("user", Q2);
  const set = draw("assistant", "", true);
  const response = await fetch("/backend-api/conversation", { method: "POST", headers: { authorization: token, "content-type": "application/json", "openai-sentinel-chat-requirements-token": "gAAAAABfixture-sentinel-token" },
    body: JSON.stringify({ action: "next", conversation_id: ID, messages: [{ author: { role: "user" }, content: { content_type: "text", parts: [Q2] } }] }) });
  let text = "";
  await sse(response, (event, data) => {
    if (data === "[DONE]") { set(text, true); return; }
    const parsed = JSON.parse(data);
    text = parsed.message.content.parts.join("");
    set(text, parsed.message.status === "finished_successfully");
  });
}
async function claude() {
  const base = "/api/organizations/" + ORG + "/chat_conversations/" + ID;
  const headers = { "anthropic-device-id": "device-fixture-5678", "x-csrf-token": "csrf-fixture-token-abcdef" };
  await (await fetch("/api/account", { headers })).json();
  const events = new EventSource("/api/organizations/" + ORG + "/notifications/stream");
  events.addEventListener("ping", () => {});
  const conversation = await (await fetch(base + "?tree=True&rendering_mode=messages&render_all_tools=true", { headers })).json();
  title(conversation.name);
  for (const message of conversation.chat_messages) draw(message.sender === "human" ? "user" : "assistant", message.content.map((c) => c.text).join(""));
  await new Promise((r) => setTimeout(r, 400));
  draw("user", Q2);
  const set = draw("assistant", "", true);
  const response = await fetch(base + "/completion", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ prompt: Q2, timezone: "Asia/Taipei" }) });
  let text = "";
  await sse(response, (event, data) => {
    const parsed = JSON.parse(data);
    if (parsed.type === "content_block_delta") { text += parsed.delta.text; set(text, false); }
    if (parsed.type === "message_stop") set(text, true);
  });
  events.close();
}
({ gemini, chatgpt, claude })[SITE]().then(() => { document.title = document.title + " · ready"; });
</script></body></html>`;

// ---- the site's traffic ----
const geminiTurn = (q, a, n) => [["c_fixture", "r_" + n], ["c_fixture", "r_" + n, "rc_" + n], [[q], 1, null], [[["rc_" + n, [a]]]]];
const wrb = (rpc, inner) => {
  const line = JSON.stringify([["wrb.fr", rpc, JSON.stringify(inner), null, null, null, "generic"]]);
  return line.length + "\n" + line + "\n";
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const path = url.pathname;
  let body = "";
  for await (const chunk of request) body += chunk;
  const send = (status, type, text, headers = {}) => { response.writeHead(status, { "content-type": type, ...headers }); response.end(text); };
  const json = (object) => send(200, "application/json", JSON.stringify(object), { "set-cookie": "__Secure-session=fixture-cookie; HttpOnly" });

  let match;
  if ((match = path.match(/^\/(app|c|chat)\/([\w-]+)$/))) {
    const site = { app: "gemini", c: "chatgpt", chat: "claude" }[match[1]];
    return send(200, "text/html; charset=utf-8", page(site, match[2], url.searchParams.get("variant")), { "set-cookie": "__Secure-1PSID=fixture-cookie; HttpOnly" });
  }
  // Gemini
  if (path === "/_/BardChatUi/data/batchexecute") {
    return send(200, "application/json; charset=utf-8", ")]}'\n\n" + wrb("hNvQHb", [[geminiTurn(Q1, A1, 1)]]));
  }
  if (path.endsWith("/StreamGenerate")) {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.write(")]}'\n\n");
    let so = "";
    for (const piece of pieces(A2)) {
      so += piece;
      response.write(wrb(null, [null, ["c_fixture", "r_2"], null, null, [["rc_2", [so]]]]));
      await sleep(60);
    }
    return response.end();
  }
  // ChatGPT
  if (path === "/api/auth/session") return json({ user: { id: "user-fixture-123", name: "Fixture User", email: EMAIL }, accessToken: JWT, expires: "2026-12-01" });
  if ((match = path.match(/^\/backend-api\/conversation\/([\w-]+)$/))) {
    return json({
      title: TITLE, current_node: "n2", conversation_id: match[1],
      mapping: {
        root: { id: "root", message: null, parent: null, children: ["n1"] },
        n1: { id: "n1", parent: "root", children: ["n2"], message: { id: "m1", author: { role: "user" }, content: { content_type: "text", parts: [Q1] } } },
        n2: { id: "n2", parent: "n1", children: [], message: { id: "m2", author: { role: "assistant" }, content: { content_type: "text", parts: [A1] } } },
      },
    });
  }
  if (path === "/backend-api/conversation") {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    let so = "";
    for (const piece of pieces(A2)) {
      so += piece;
      response.write("data: " + JSON.stringify({ message: { id: "m4", author: { role: "assistant" }, content: { content_type: "text", parts: [so] }, status: "in_progress" }, conversation_id: "x" }) + "\n\n");
      await sleep(60);
    }
    response.write("data: " + JSON.stringify({ message: { id: "m4", author: { role: "assistant" }, content: { content_type: "text", parts: [A2] }, status: "finished_successfully" }, conversation_id: "x" }) + "\n\n");
    response.write("data: [DONE]\n\n");
    return response.end();
  }
  // Claude
  if (path === "/api/account") return json({ uuid: "acct-fixture", email_address: EMAIL, full_name: "Fixture User", memberships: [{ organization: { uuid: ORG, name: "Personal" } }] });
  if (path.endsWith("/notifications/stream")) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: ping\ndata: {\"n\":1}\n\n");
    await sleep(200);
    response.write("data: {\"n\":2}\n\n");
    return; // left open; the page closes it
  }
  if ((match = path.match(/^\/api\/organizations\/[\w-]+\/chat_conversations\/([\w-]+)$/))) {
    return json({
      uuid: match[1], name: TITLE,
      chat_messages: [
        { uuid: "m1", index: 0, sender: "human", content: [{ type: "text", text: Q1 }] },
        { uuid: "m2", index: 1, sender: "assistant", content: [{ type: "text", text: A1 }] },
      ],
    });
  }
  if (path.endsWith("/completion")) {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    response.write("event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { id: "msg_fixture", role: "assistant" } }) + "\n\n");
    for (const piece of pieces(A2)) {
      response.write("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } }) + "\n\n");
      await sleep(60);
    }
    response.write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
    return response.end();
  }
  send(404, "text/plain", "not found");
});
server.listen(port, "127.0.0.1", () => console.log(`fixtures on http://127.0.0.1:${port}`));
