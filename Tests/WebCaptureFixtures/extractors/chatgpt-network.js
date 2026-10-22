
// ---- FIXTURE traffic reader (tests only): ChatGPT's conversation JSON and SSE answer ----
// Written against the fixture server's mimicry of ChatGPT's traffic, not checked on chatgpt.com.
const NETWORK = { urls: ["/backend-api/conversation"] };

function extractNetwork(exchanges, context) {
  let title = null;
  const turns = [];
  for (const exchange of exchanges) {
    if (exchange.method === "GET" && /\/backend-api\/conversation\/[\w-]+/.test(exchange.url)) {
      const conversation = JSON.parse(exchange.responseBody);
      title = conversation.title || title;
      const chain = [];
      let node = conversation.mapping[conversation.current_node];
      while (node) { if (node.message) chain.unshift(node.message); node = conversation.mapping[node.parent]; }
      for (const message of chain) turns.push({ role: message.author.role, text: message.content.parts.join("") });
    } else if (exchange.method === "POST" && /\/backend-api\/conversation$/.test(exchange.url) && exchange.done) {
      const asked = JSON.parse(exchange.requestBody).messages[0].content.parts.join("");
      let last = null;
      for (const line of exchange.responseBody.split("\n")) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        try { last = JSON.parse(line.slice(6)); } catch (e) { /* partial */ }
      }
      turns.push({ role: "user", text: asked });
      if (last) turns.push({ role: "assistant", text: last.message.content.parts.join("") });
    }
  }
  return turns.length ? { title, turns } : null;
}
