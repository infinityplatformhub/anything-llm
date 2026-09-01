/**
 * E2E mock LLM/embedding provider — canned SSE via generic OpenAI-compatible
 * endpoints. Deterministic: chat always streams the same short answer; the
 * embedder hashes input to a fixed-dimension vector so identical text embeds
 * identically (needed for the citation lookup path).
 */
const http = require("http");

const CHAT_ANSWER =
  "The answer is forty-two. This response is canned for the E2E gate.";

function embed(text, dim) {
  // Simple deterministic hash -> vector; same text => same vector.
  const vec = new Array(dim).fill(0);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  for (let i = 0; i < dim; i++) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    vec[i] = ((h >>> 0) % 2000 - 1000) / 1000;
  }
  return vec;
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const payload = JSON.parse(body || "{}");
    if (req.url.endsWith("/embeddings")) {
      const input = Array.isArray(payload.input)
        ? payload.input.join(" ")
        : String(payload.input ?? "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: embed(input, 512) }],
          model: payload.model ?? "mock-embed",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        })
      );
      return;
    }
    if (req.url.endsWith("/chat/completions")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const chunks = [CHAT_ANSWER.slice(0, 20), CHAT_ANSWER.slice(20)];
      chunks.forEach((text, i) => {
        res.write(
          `data: ${JSON.stringify({
            id: "mock",
            object: "chat.completion.chunk",
            created: 1,
            model: payload.model ?? "mock",
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          })}\n\n`
        );
      });
      res.write(
        `data: ${JSON.stringify({
          id: "mock",
          object: "chat.completion.chunk",
          created: 1,
          model: payload.model ?? "mock",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    // /v1/models and friends
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ object: "list", data: [{ id: "mock-llm" }] })
    );
  });
});
server.listen(8080);
