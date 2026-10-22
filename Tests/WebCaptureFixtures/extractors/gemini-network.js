
// ---- FIXTURE traffic reader (tests only): Gemini's batchexecute history and StreamGenerate ----
// Written against the fixture server's mimicry of Gemini's traffic, not checked on gemini.google.com.
const NETWORK = { urls: ["/batchexecute\\?.*rpcids=hNvQHb", "/StreamGenerate"] };

// `)]}'` then length-prefixed lines, each `[["wrb.fr", rpc, "<inner JSON>", ...]]`.
function geminiFrames(text) {
  const frames = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.startsWith("[[")) continue;
    try {
      for (const entry of JSON.parse(line)) if (entry[0] === "wrb.fr" && typeof entry[2] === "string") frames.push({ rpc: entry[1], inner: JSON.parse(entry[2]) });
    } catch (e) { /* a partial line */ }
  }
  return frames;
}

function extractNetwork(exchanges, context) {
  const turns = [];
  for (const exchange of exchanges) {
    const frames = geminiFrames(exchange.responseBody);
    if (/rpcids=hNvQHb/.test(exchange.url)) {
      for (const frame of frames) {
        for (const turn of (frame.inner[0] || []).slice().reverse()) {
          turns.push({ role: "user", text: turn[2][0][0] });
          turns.push({ role: "assistant", text: turn[3][0][0][1][0] });
        }
      }
    } else if (/StreamGenerate/.test(exchange.url) && exchange.done && frames.length) {
      const request = new URLSearchParams(exchange.requestBody || "").get("f.req");
      const question = request ? JSON.parse(JSON.parse(request)[1])[0][0] : null;
      if (question) turns.push({ role: "user", text: question });
      turns.push({ role: "assistant", text: frames[frames.length - 1].inner[4][0][1][0] });
    }
  }
  return turns.length ? { title: null, turns } : null;
}
