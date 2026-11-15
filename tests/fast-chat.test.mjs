import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFastChat, staticFastReply, shouldUseDirectMessageFastPath } from "../src/lib/server/fast-chat.ts";

test("greetings and acknowledgements are answered without loading a model", () => {
  assert.deepEqual(classifyFastChat("hi"), { kind: "static", reply: "Hi! How can I help?" });
  assert.equal(staticFastReply("hello!!!"), "Hi! How can I help?");
  assert.equal(staticFastReply("thanks"), "You're welcome!");
  assert.equal(staticFastReply("okay"), "Great.");
});

test("ordinary knowledge questions use the lightweight chat path", () => {
  assert.deepEqual(classifyFastChat("What is AI?"), { kind: "model" });
  assert.deepEqual(classifyFastChat("Explain Docker in simple words."), { kind: "model" });
  assert.deepEqual(classifyFastChat("How does TCP work?"), { kind: "model" });
});

test("integration, coding and multi-step requests stay on the agent workflow", () => {
  assert.deepEqual(classifyFastChat("List all my GitHub repositories."), { kind: "agent" });
  assert.deepEqual(classifyFastChat("Search the web for the latest OpenAI API docs."), { kind: "agent" });
  assert.deepEqual(classifyFastChat("Debug this Python script."), { kind: "agent" });
  assert.deepEqual(classifyFastChat("Build a full application with authentication."), { kind: "agent" });
});

test("explicit memory actions stay on the agent workflow", () => {
  assert.deepEqual(classifyFastChat("Remember the exact note: fallback must not duplicate"), { kind: "agent" });
  assert.deepEqual(classifyFastChat("Save this preference for later"), { kind: "agent" });
  assert.deepEqual(classifyFastChat("Edit my MEMORY.md to correct this detail"), { kind: "agent" });
});

test("Ollama fast chat disables thinking and tool calls and bounds the reply", async () => {
  const { requestOllamaFastReply } = await import("../src/lib/server/fast-chat.ts");
  let requestBody;
  const result = await requestOllamaFastReply({
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3:4b",
    messages: [
      { role: "system", content: "Answer briefly." },
      { role: "user", content: "What is AI?" },
    ],
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "http://127.0.0.1:11434/api/chat");
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ message: { content: "AI means Artificial Intelligence." }, prompt_eval_count: 12, eval_count: 8 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(requestBody.think, false);
  assert.equal(requestBody.stream, false);
  assert.equal(requestBody.model, "qwen3:4b");
  assert.equal(requestBody.options.num_predict, 384);
  assert.equal("tools" in requestBody, false);
  assert.deepEqual(result, { content: "AI means Artificial Intelligence.", inputTokens: 12, outputTokens: 8 });
});


test("direct-message routing uses fast path for general chat", () => {
  assert.equal(shouldUseDirectMessageFastPath({ modelTask: "general", conversationId: "dm:scout" }), true);
  assert.equal(shouldUseDirectMessageFastPath({ modelTask: "research", conversationId: "dm:scout" }), false);
  assert.equal(shouldUseDirectMessageFastPath({ modelTask: "general", conversationId: "room:team" }), false);
});
