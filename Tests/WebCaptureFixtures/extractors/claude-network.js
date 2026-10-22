
// ---- FIXTURE traffic reader (tests only): Claude's chat_conversations JSON and SSE completion ----
// Written against the fixture server's mimicry of Claude's traffic, not checked on claude.ai.
const NETWORK = { urls: ["/chat_conversations/[\\w-]+(\\?|$)", "/completion$"] };

function extractNetwork(exchanges, context) {
  let title = null;
  const turns = [];
  for (const exchange of exchanges) {
    if (exchange.method === "GET") {
      const conversation = JSON.parse(exchange.responseBody);
      title = conversation.name || title;
      for (const message of conversation.chat_messages) {
        turns.push({ role: message.sender === "human" ? "user" : "assistant", text: message.content.map((part) => part.text || "").join("") });
      }
    } else if (exchange.done) {
      turns.push({ role: "user", text: JSON.parse(exchange.requestBody).prompt });
      let text = "";
      for (const line of exchange.responseBody.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === "content_block_delta") text += event.delta.text;
      }
      turns.push({ role: "assistant", text });
    }
  }
  return turns.length ? { title, turns } : null;
}
