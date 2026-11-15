/** Small, deterministic router for chat that should not enter the agent/tool loop. */
export type FastChatRoute =
  | { kind: "static"; reply: string }
  | { kind: "model" }
  | { kind: "agent" };


/** Direct-message general chat can skip Mastra routing metadata; room turns cannot. */
export function shouldUseDirectMessageFastPath(options: { modelTask: string; conversationId: string }): boolean {
  return options.modelTask === "general" && options.conversationId.startsWith("dm:");
}

const GREETING = /^(?:hi|hello|hey|hiya|yo|good morning|good afternoon|good evening|howdy)(?:\s+(?:there|scout|everyone))?[!.?,\s]*$/i;
const THANKS = /^(?:thanks|thank you|thx|ty)[!.?,\s]*$/i;
const ACK = /^(?:ok|okay|got it|understood|cool|great|nice)[!.?,\s]*$/i;

const TOOL_OR_COMPLEX_INTENT = [
  /\b(list|show|get|find|fetch|check)\b.{0,50}\b(repositories|repos|issues|pull requests|commits)\b/i,
  /\b(github|gmail|slack|notion|google drive|calendar)\b.{0,45}\b(connect|list|show|fetch|search|send|create|update|delete|check)\b/i,
  /\b(search the web|web search|look up|latest news|current news|today's news|browse the web|open this (?:url|website)|visit this site)\b/i,
  /\b(send (?:an? )?email|check (?:my )?inbox|schedule (?:a|an)|create (?:a )?(?:calendar )?event|post to slack)\b/i,
  /\b(remember|save|store|memorize)\b.{0,80}\b(note|memory|preference|fact|detail|this)\b/i,
  /\b(memory|memory\.md)\b.{0,50}\b(edit|update|delete|forget|remove)\b/i,
  /\b(edit|update|delete|forget|remove)\b.{0,50}\b(memory|memory\.md)\b/i,
  /\b(write|run|execute|debug|modify|edit|create|build|implement|refactor)\b.{0,45}\b(code|script|program|file|application|app|project|repository|repo|website|api|database)\b/i,
  /\b(deep research|comprehensive research|multi[- ]step|step[- ]by[- ]step implementation|analyze this (?:project|repository|codebase)|review this (?:project|repository|codebase))\b/i,
];

export function classifyFastChat(input: string): FastChatRoute {
  const text = input.trim();
  if (GREETING.test(text)) return { kind: "static", reply: "Hi! How can I help?" };
  if (THANKS.test(text)) return { kind: "static", reply: "You're welcome!" };
  if (ACK.test(text)) return { kind: "static", reply: "Great." };
  if (!text || text.length > 1800 || TOOL_OR_COMPLEX_INTENT.some((pattern) => pattern.test(text))) {
    return { kind: "agent" };
  }
  return { kind: "model" };
}

export function staticFastReply(input: string): string | null {
  const route = classifyFastChat(input);
  return route.kind === "static" ? route.reply : null;
}

export interface OllamaFastMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaFastReply {
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Call Ollama's native chat API with thinking and tool calls explicitly disabled. */
export async function requestOllamaFastReply(options: {
  baseUrl: string;
  model: string;
  messages: OllamaFastMessage[];
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<OllamaFastReply> {
  const base = new URL(options.baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("OLLAMA_BASE_URL must be a valid HTTP(S) URL without credentials or query parameters.");
  }
  const fetcher = options.fetchImpl ?? fetch;
  const response = await fetcher(new URL("api/chat", `${base.href.replace(/\/+$/, "")}/`), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      stream: false,
      think: false,
      keep_alive: "10m",
      options: { temperature: 0.35, top_p: 0.9, num_predict: 384 },
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}. Check that Ollama is running and the selected model is installed.`);
  const payload = await response.json() as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };
  const content = payload.message?.content?.trim() ?? "";
  if (!content) throw new Error("Ollama returned an empty answer. Check that this model supports the Ollama chat API.");
  return {
    content,
    inputTokens: typeof payload.prompt_eval_count === "number" ? payload.prompt_eval_count : null,
    outputTokens: typeof payload.eval_count === "number" ? payload.eval_count : null,
  };
}
