// The agent harness glue. Mastra's AgentController owns the agent loop,
// sessions, thread history, tool approvals and ask-user suspensions. This file
// gives each bot one controller, each conversation one session, and folds the
// controller's events into the chat messages the UI renders.
import { Agent } from "@mastra/core/agent";
import { AgentController, type AgentControllerEvent, type Session } from "@mastra/core/agent-controller";
import { RequestContext } from "@mastra/core/request-context";
import type { MastraBrowser } from "@mastra/core/browser";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { randomUUID } from "node:crypto";
import type { ApprovalRequest, Bot, ChatMessage, ConversationId, ModelTaskType, Part, RouteNote } from "@/lib/shared/types";
import { MASTRA_DB_URL, OWNER_ID } from "./config";
import {
  cancelPendingApprovalRequests,
  cancelApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
  failApprovalResume,
  getApprovalRequest,
  markApprovalOutcomeUnknown,
  conversationGeneration,
  getBot,
  saveMessage,
  listMessages,
} from "./db";
import { canAccessProjectMemory, projectMemoryThreadId } from "./project-memory";
import {
  APPROVAL_REQUEST_TTL_MS,
  approvalActionLabel,
  approvalDetails,
  approvalPolicyForTool,
  executionTaskForConversation,
  safeApprovalText,
} from "./approval-core";
import { publish } from "./bus";
import { InputError } from "./errors";
import {
  costUsd,
  findModel,
  isModelResolution,
  mastraModelForResolution,
  MODEL_REQUEST_CONTEXT_KEY,
  resolveModelForBot,
  type ModelResolution,
} from "./models";
import { createMockModel } from "./mock-model";
import { announceLiveView, createSession, releaseSession } from "./browserbase";
import { buildConnectorTools, connectionsVersion } from "./connectors";
import { listGitHubRepositoriesDirect } from "./composio";
import { isGitHubRepositoryListRequest } from "./github-request";
import { systemPrompt } from "./prompt";
import { buildTools, toolCategory, toolLabel, toolPreview, toolSources } from "./tools";
import { createKeyedLock } from "./execution-core";
import { classifyFastChat, requestOllamaFastReply, shouldUseDirectMessageFastPath } from "./fast-chat";

// ── shared state that must survive Next.js hot reloads ─────────────────

interface BotRuntime {
  signature: string;
  /** The latest saved bot; the system prompt reads it on every model call. */
  holder: { bot: Bot; resolution?: ModelResolution };
  controller: AgentController;
  toolNames: Set<string>;
  ready: Promise<void>;
  /** Disconnects the bot's MCP servers. */
  closeConnectors: () => Promise<void>;
}

interface State {
  storage: LibSQLStore;
  runtimes: Map<string, BotRuntime>;
  /** `${conversationId}|${botId}` → live session */
  sessions: Map<string, Session>;
  /** `${conversationId}|${botId}` → tail of that bot's turn queue */
  chains: Map<string, Promise<unknown>>;
  /** conversationId → bots with a turn in flight */
  running: Map<ConversationId, Set<string>>;
  /** `${conversationId}|${botId}` → the turn currently folding events */
  folders: Map<string, TurnFolder>;
  /** conversationId → bumped by Stop, so turns queued before it never start */
  stopEpoch: Map<ConversationId, number>;
  /** Browser sessions are shared per bot, so browser turns must share one queue. */
  browserLock: ReturnType<typeof createKeyedLock>;
}

const g = globalThis as unknown as { __opencrewbotRuntime?: State };
const state: State = (g.__opencrewbotRuntime ??= {
  storage: new LibSQLStore({ id: "opencrewbot-mastra", url: MASTRA_DB_URL }),
  runtimes: new Map(),
  sessions: new Map(),
  chains: new Map(),
  running: new Map(),
  folders: new Map(),
  stopEpoch: new Map(),
  browserLock: createKeyedLock(),
});
state.browserLock ??= createKeyedLock();

const key = (conversationId: ConversationId, botId: string) => `${conversationId}|${botId}`;

// ── one controller per bot ──────────────────────────────────────────────

/** Settings that need a new controller when they change. Persona text doesn't:
 * the system prompt is rebuilt from the latest bot on every model call. */
async function signatureOf(bot: Bot): Promise<string> {
  // The model isn't here: it's read from the latest bot on every call, so a
  // model switch applies to the next reply without dropping any sessions.
  // Connections are, along with a version that bumps when any app or server changes.
  return JSON.stringify({
    tools: bot.tools,
    approval: bot.approval,
    approvalPermissions: bot.approvalPermissions ?? [],
    skillIds: bot.skillIds ?? [],
    connections: bot.connections,
    connectionsVersion: bot.connections.length ? await connectionsVersion() : 0,
    sharedProjectMemoryAuthorized: await canAccessProjectMemory(bot.id),
  });
}

/** A Browserbase cloud browser, reached over CDP. The session starts on the
 * bot's first browser action and is released when its controller closes. */
async function createBrowser(bot: Bot): Promise<MastraBrowser | undefined> {
  if (!bot.tools.browser) return undefined;
  const { AgentBrowser } = await import("@mastra/agent-browser");
  const model = await findModel(bot.model, bot.modelProvider ?? "nebius");
  return new AgentBrowser({
    cdpUrl: () => createSession(bot.id),
    scope: "shared",
    onLaunch: () => announceLiveView(bot.id),
    onClose: () => releaseSession(bot.id),
    // A screenshot comes back as an image, which text-only models can't read.
    excludeTools: model?.available && model.vision ? [] : ["browser_screenshot"],
  }) as unknown as MastraBrowser;
}

async function buildRuntime(bot: Bot): Promise<BotRuntime> {
  const holder: BotRuntime["holder"] = { bot };
  const memory = new Memory({ storage: state.storage, options: { lastMessages: 40 } });
  const connectors = await buildConnectorTools(bot, `bot-${bot.id}-${Date.now()}`);
  const builtIn = buildTools(bot, new Set(Object.keys(connectors.tools)), await canAccessProjectMemory(bot.id));
  const tools = { ...connectors.tools, ...builtIn.tools };
  const capabilities = [...builtIn.capabilities, ...connectors.capabilities];
  const agent = new Agent({
    id: `bot-${bot.id}`,
    name: bot.name,
    instructions: () => systemPrompt(holder.bot, capabilities, builtIn.instructions),
    model: ({ requestContext }) => {
      const value: unknown = requestContext?.get(MODEL_REQUEST_CONTEXT_KEY);
      // Mastra may re-enter the model router while resuming a suspended tool
      // approval without forwarding the original RequestContext. Keep the
      // resolution selected for this bot's active/latest turn as a safe fallback.
      const resolution = isModelResolution(value) ? value : holder.resolution;
      if (!isModelResolution(resolution)) {
        throw new Error("No model is configured for this bot. Select an available model in Scout settings and retry.");
      }
      return resolution.simulated ? createMockModel(holder.bot.name) : mastraModelForResolution(resolution);
    },
    tools,
    memory,
  });
  const browser = await createBrowser(bot);
  const controller = new AgentController({
    id: `controller-${bot.id}`,
    agent,
    storage: state.storage,
    modes: [{ id: "chat", name: "Chat", metadata: { default: true } }],
    browser,
    toolCategoryResolver: toolCategory,
    disableBuiltinTools: [
      "submit_plan",
      "task_write",
      "task_update",
      "task_complete",
      "task_check",
      "subagent",
      ...(bot.tools.askUser ? [] : (["ask_user"] as const)),
    ],
  });
  return {
    signature: await signatureOf(bot),
    holder,
    controller,
    toolNames: new Set(Object.keys(tools)),
    ready: controller.init(),
    closeConnectors: connectors.close,
  };
}

function isBotBusy(botId: string): boolean {
  for (const bots of state.running.values()) if (bots.has(botId)) return true;
  return false;
}

async function dropRuntime(botId: string): Promise<void> {
  const runtime = state.runtimes.get(botId);
  if (!runtime) return;
  state.runtimes.delete(botId);
  for (const k of [...state.sessions.keys()]) if (k.endsWith(`|${botId}`)) state.sessions.delete(k);
  await runtime.controller.destroy().catch(() => {});
  await runtime.closeConnectors().catch(() => {});
  await releaseSession(botId);
}

async function runtimeFor(bot: Bot): Promise<BotRuntime> {
  let runtime = state.runtimes.get(bot.id);
  if (runtime && runtime.signature !== (await signatureOf(bot)) && !isBotBusy(bot.id)) {
    await dropRuntime(bot.id);
    runtime = undefined;
  }
  if (!runtime) {
    runtime = await buildRuntime(bot);
    state.runtimes.set(bot.id, runtime);
  }
  runtime.holder.bot = bot;
  await runtime.ready;
  return runtime;
}

async function sessionFor(bot: Bot, conversationId: ConversationId): Promise<Session> {
  const runtime = await runtimeFor(bot);
  const generation = await conversationGeneration(conversationId);
  const threadId = await projectMemoryThreadId(`${conversationId}:${bot.id}:${generation}`, bot.id);
  const k = key(conversationId, bot.id);
  const cached = state.sessions.get(k);
  if (cached && cached.thread.getId() === threadId) return cached;
  const session = await runtime.controller.createSession({ resourceId: OWNER_ID, scope: conversationId, threadId });
  const categories = ["read", "edit", "execute", "mcp", "other"] as const;
  for (const category of categories) {
    const policy = bot.approval === "full"
      ? "allow"
      : category === "read" || (category === "edit" && bot.approval === "ask")
        ? "allow"
        : "ask";
    await session.permissions.setForCategory({ category, policy });
  }
  for (const toolName of runtime.toolNames) {
    await session.permissions.setForTool({
      toolName,
      policy: approvalPolicyForTool(bot.approval, bot.approvalPermissions ?? [], toolName, toolCategory(toolName) ?? "other"),
    });
  }
  state.sessions.set(k, session);
  return session;
}

// ── running state ──────────────────────────────────────────────────────

function setRunning(conversationId: ConversationId, botId: string, on: boolean) {
  const bots = state.running.get(conversationId) ?? new Set<string>();
  if (on) bots.add(botId);
  else bots.delete(botId);
  if (bots.size) state.running.set(conversationId, bots);
  else state.running.delete(conversationId);
  publish({ type: "running", conversationId, botIds: [...bots] });
}

/** Changes whenever Stop is pressed in this conversation. */
export function stopEpochOf(conversationId: ConversationId): number {
  return state.stopEpoch.get(conversationId) ?? 0;
}

export function runningBots(conversationId: ConversationId): string[] {
  return [...(state.running.get(conversationId) ?? [])];
}

// ── folding controller events into one chat message per turn ────────────

class TurnFolder {
  readonly message: ChatMessage;
  private textPart = new Map<string, number>();
  private reasoningPart = new Map<string, number>();
  private toolPart = new Map<string, number>();
  private input: number | null = null;
  private output: number | null = null;
  private resolution?: ModelResolution;
  private resolveDone!: (m: ChatMessage) => void;
  readonly done = new Promise<ChatMessage>((r) => (this.resolveDone = r));
  finished = false;

  constructor(
    conversationId: ConversationId,
    private readonly bot: Bot,
    route?: RouteNote,
    private readonly onProgress?: (message: ChatMessage) => void,
  ) {
    this.message = {
      id: randomUUID(),
      conversationId,
      role: "bot",
      botId: bot.id,
      createdAt: new Date().toISOString(),
      status: "streaming",
      parts: [],
      model: bot.model,
      route,
    };
  }

  setModelResolution(resolution: ModelResolution) {
    this.resolution = resolution;
    this.message.model = resolution.simulated ? "mock" : resolution.model;
    this.emit();
  }

  private emit(persist = false) {
    this.onProgress?.(this.message);
    publish({ type: "message", message: this.message });
    if (persist) void saveMessage(this.message);
  }

  private streamInto(kind: "text" | "reasoning", sourceId: string, delta: string) {
    const index = kind === "text" ? this.textPart : this.reasoningPart;
    let i = index.get(sourceId);
    const last = this.message.parts.length - 1;
    // Start a new part when another part (a tool call) came in between.
    if (i === undefined || i !== last) {
      this.message.parts.push({ kind, text: "" });
      i = this.message.parts.length - 1;
      index.set(sourceId, i);
      this.emit();
    }
    const part = this.message.parts[i] as { text: string };
    part.text += delta;
    publish({ type: "delta", conversationId: this.message.conversationId, messageId: this.message.id, partIndex: i, kind, delta });
  }

  private tool(toolCallId: string): Extract<Part, { kind: "tool" }> | undefined {
    const i = this.toolPart.get(toolCallId);
    return i === undefined ? undefined : (this.message.parts[i] as Extract<Part, { kind: "tool" }>);
  }

  waitingOnPerson(): boolean {
    return this.message.parts.some(
      (p) => (p.kind === "tool" && p.status === "awaiting-approval") || (p.kind === "question" && p.answer === undefined),
    );
  }

  async handle(event: AgentControllerEvent) {
    if (this.finished) return;
    switch (event.type) {
      case "message_update": {
        // Reasoning is internal model output; never persist or publish it to chat.
        if (event.event.type === "text-delta") this.streamInto("text", event.id, event.event.delta);
        break;
      }
      case "tool_start": {
        if (event.toolName === "ask_user" || this.toolPart.has(event.toolCallId)) break;
        const { label, detail } = toolLabel(event.toolName, event.args);
        this.message.parts.push({
          kind: "tool",
          toolCallId: event.toolCallId,
          name: event.toolName,
          label: safeApprovalText(label),
          detail: detail ? safeApprovalText(detail) : undefined,
          status: "running",
        });
        this.toolPart.set(event.toolCallId, this.message.parts.length - 1);
        this.emit(true);
        break;
      }
      case "tool_approval_required": {
        let part = this.tool(event.toolCallId);
        const { label, detail } = toolLabel(event.toolName, event.args);
        if (!part) {
          this.message.parts.push({
            kind: "tool",
            toolCallId: event.toolCallId,
            name: event.toolName,
            label: safeApprovalText(label),
            detail: detail ? safeApprovalText(detail) : undefined,
            status: "awaiting-approval",
          });
          this.toolPart.set(event.toolCallId, this.message.parts.length - 1);
          part = this.tool(event.toolCallId);
        }
        part!.status = "awaiting-approval";
        const request: ApprovalRequest = {
          id: randomUUID(),
          conversationId: this.message.conversationId,
          botId: this.message.botId!,
          messageId: this.message.id,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          action: approvalActionLabel(label, detail),
          details: approvalDetails(event.args),
          status: "pending",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + APPROVAL_REQUEST_TTL_MS).toISOString(),
          ...executionTaskForConversation(this.message.conversationId),
        };
        await createApprovalRequest(request);
        this.emit(true);
        break;
      }
      case "tool_suspended": {
        if (event.toolName !== "ask_user") break;
        const payload = (event.suspendPayload ?? {}) as { question?: string; options?: { label: string; description?: string }[] };
        this.message.parts.push({
          kind: "question",
          toolCallId: event.toolCallId,
          question: payload.question ?? String((event.args as { question?: string })?.question ?? "The bot has a question."),
          options: payload.options ?? [],
        });
        this.emit(true);
        break;
      }
      case "tool_end": {
        const part = this.tool(event.toolCallId);
        if (!part) break;
        part.status = event.denied ? "denied" : event.isError ? "error" : "done";
        part.preview = toolPreview(event.result);
        part.sources = toolSources(event.result);
        this.emit(true);
        break;
      }
      case "usage_update": {
        const u = event.usage as { promptTokens?: number; completionTokens?: number };
        if (typeof u.promptTokens === "number" && Number.isFinite(u.promptTokens)) {
          this.input = (this.input ?? 0) + u.promptTokens;
        }
        if (typeof u.completionTokens === "number" && Number.isFinite(u.completionTokens)) {
          this.output = (this.output ?? 0) + u.completionTokens;
        }
        break;
      }
      case "error": {
        this.message.error = event.error?.message || "The model returned an error.";
        break;
      }
      case "agent_end": {
        if (event.reason === "suspended") {
          this.emit(true);
          break;
        }
        void this.finish(event.reason === "aborted" ? "stopped" : event.reason === "error" ? "error" : "done");
        break;
      }
    }
  }

  answer(toolCallId: string, answer: string) {
    const part = this.message.parts.find((p) => p.kind === "question" && p.toolCallId === toolCallId);
    if (part && part.kind === "question") part.answer = answer;
    this.emit(true);
  }

  approval(toolCallId: string, approve: boolean | undefined) {
    const part = this.tool(toolCallId);
    if (!part) return;
    part.status = approve === undefined ? "awaiting-approval" : approve ? "running" : "denied";
    this.emit(true);
  }

  approvalOutcomeUnknown(toolCallId: string) {
    const part = this.tool(toolCallId);
    if (!part) return;
    part.status = "outcome_unknown";
    this.emit(true);
  }

  waitingForApproval(toolCallId: string): boolean {
    return this.tool(toolCallId)?.status === "awaiting-approval";
  }

  failApprovalPersistence(toolCallId: string) {
    this.approval(toolCallId, false);
    void this.finish("error", "The approval request could not be saved, so the action was not allowed.");
  }

  async finish(status: ChatMessage["status"], error?: string) {
    if (this.finished) return;
    this.finished = true;
    if (error) this.message.error = error;
    if (this.message.error && status === "done" && !this.message.parts.some((p) => p.kind === "text" && p.text.trim())) {
      status = "error";
    }
    this.message.status = status;
    for (const p of this.message.parts) {
      if (p.kind === "tool" && (p.status === "running" || p.status === "awaiting-approval")) {
        if (p.status === "awaiting-approval" && this.message.botId) {
          try {
            await cancelApprovalRequest(
              this.message.conversationId,
              this.message.botId,
              p.toolCallId,
              status === "stopped" ? "turn-stopped" : "turn-finished",
            );
          } catch (error) {
            console.error("[opencrewbot] Could not close a pending approval.", error);
          }
        }
        p.status = status === "stopped" ? "denied" : "error";
      }
    }
    this.message.usage = {
      input: this.input,
      output: this.output,
      costUsd: this.resolution?.simulated ? null : costUsd(this.resolution?.option, this.input, this.output),
      provider: this.resolution?.providerId ?? this.botProvider,
      model: this.resolution?.model ?? this.message.model ?? "unknown",
      requestedAt: this.message.createdAt,
      simulated: this.resolution?.simulated ?? false,
      ...(this.resolution?.fallbackFrom ? { fallbackFrom: this.resolution.fallbackFrom } : {}),
    };
    this.onProgress?.(this.message);
    await saveMessage(this.message);
    publish({ type: "message", message: this.message });
    this.resolveDone(this.message);
  }

  private get botProvider(): "nebius" | "ollama" {
    return this.bot.modelProvider ?? "nebius";
  }
}

// ── public API ──────────────────────────────────────────────────────────

export interface TurnRequest {
  bot: Bot;
  conversationId: ConversationId;
  /** What the bot receives: the person's words, or a room's catch-up text. */
  content: string;
  route?: RouteNote;
  modelTask?: ModelTaskType;
  onProgress?: (message: ChatMessage) => void;
}

/** Queue one turn for one bot in one conversation and resolve with its reply,
 * or null when Stop cancelled it before it started. */
export function runTurn(request: TurnRequest): Promise<ChatMessage | null> {
  const epoch = state.stopEpoch.get(request.conversationId) ?? 0;
  const run = async () => {
    if ((state.stopEpoch.get(request.conversationId) ?? 0) !== epoch) return null;
    return executeTurn(request);
  };
  if (request.bot.tools.browser) return state.browserLock(request.bot.id, run);

  const k = key(request.conversationId, request.bot.id);
  const previous = state.chains.get(k) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  state.chains.set(k, next);
  void next.finally(() => {
    if (state.chains.get(k) === next) state.chains.delete(k);
  });
  return next;
}

async function executeDirectGitHubRepositoryListing(request: TurnRequest, bot: Bot): Promise<ChatMessage> {
  const message: ChatMessage = {
    id: randomUUID(), conversationId: request.conversationId, role: "bot", botId: bot.id,
    createdAt: new Date().toISOString(), status: "streaming", parts: [],
    model: "GitHub API (direct)", route: request.route,
  };
  setRunning(request.conversationId, bot.id, true);
  try {
    await saveMessage(message);
    publish({ type: "message", message });
    request.onProgress?.(message);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let result: string;
    try {
      result = await Promise.race([
        listGitHubRepositoriesDirect(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("GitHub repository listing timed out after 90 seconds.")), 90_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    message.parts = [{ kind: "text", text: result }];
    message.status = "done";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    message.parts = [{ kind: "text", text: `GitHub repository listing failed: ${detail}` }];
    message.error = detail;
    message.status = "error";
  } finally {
    await saveMessage(message);
    publish({ type: "message", message });
    request.onProgress?.(message);
    setRunning(request.conversationId, bot.id, false);
  }
  return message;
}

async function executeFastChatTurn(
  bot: Bot,
  conversationId: ConversationId,
  content: string,
  reply: string | null,
  onProgress?: (message: ChatMessage) => void,
): Promise<ChatMessage> {
  const selection = bot.modelRouting?.general ?? { providerId: bot.modelProvider ?? "nebius", model: bot.model };
  const message: ChatMessage = {
    id: randomUUID(), conversationId, role: "bot", botId: bot.id,
    createdAt: new Date().toISOString(), status: "streaming", parts: [], model: selection.model,
  };
  setRunning(conversationId, bot.id, true);
  try {
    await saveMessage(message);
    publish({ type: "message", message });
    let answer = reply;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    if (answer === null) {
      const previous = (await listMessages(conversationId, 10)).filter((item) => item.id !== message.id && item.role !== "notice");
      const history = previous.flatMap((item) => {
        const text = item.parts.filter((part): part is Extract<Part, { kind: "text" }> => part.kind === "text").map((part) => part.text).join("\n").trim();
        if (!text) return [];
        return [{ role: item.role === "user" ? "user" as const : "assistant" as const, content: text.slice(0, 6000) }];
      }).slice(-8).map((item) => ({ ...item, content: item.content.slice(-2500) }));
      const system = [
        `You are ${bot.name}${bot.title ? `, ${bot.title}` : ""}.`,
        bot.description,
        bot.instructions.slice(0, 2500),
        "Answer the user's latest message directly and naturally. Output only the final answer. Never include internal thoughts, analysis, planning, self-talk, hidden reasoning, or phrases such as 'Let me think' / 'The user asked'. Do not narrate how you will answer. Do not reveal private reasoning. Do not call tools. Keep ordinary answers concise; expand only when asked.",
      ].filter(Boolean).join("\n\n");
      const result = await requestOllamaFastReply({
        baseUrl: process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434",
        model: selection.model,
        messages: [{ role: "system", content: system }, ...history],
        apiKey: process.env.OLLAMA_API_KEY,
      });
      answer = result.content;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
    }
    message.parts = [{ kind: "text", text: answer }];
    message.status = "done";
    message.usage = {
      input: inputTokens, output: outputTokens, costUsd: null,
      provider: reply === null ? "ollama" : selection.providerId,
      model: selection.model, requestedAt: message.createdAt, simulated: false,
    };
  } catch (error) {
    message.status = "error";
    message.error = error instanceof Error ? error.message : String(error);
    message.parts = [{ kind: "text", text: `I couldn't complete this quick reply: ${message.error}` }];
  } finally {
    onProgress?.(message);
    await saveMessage(message).catch((error) => console.error("[opencrewbot] Could not persist fast-chat reply.", error));
    publish({ type: "message", message });
    setRunning(conversationId, bot.id, false);
  }
  return message;
}

async function executeTurn({ bot, conversationId, content, route, modelTask = "general", onProgress }: TurnRequest): Promise<ChatMessage> {
  const latest = (await getBot(bot.id)) ?? bot;
  if (isGitHubRepositoryListRequest(content) && latest.connections.includes("composio:github")) {
    return executeDirectGitHubRepositoryListing({ bot: latest, conversationId, content, route, modelTask, onProgress }, latest);
  }
  // Direct-message chat does not need room routing metadata to qualify for the
  // lightweight path. For local Ollama bots, greetings are answered instantly
  // and ordinary chat uses native /api/chat
  // with think:false, no tools, bounded output and recent transcript context.
  // Explicit integrations, research, coding and multi-step work still use Mastra.
  const fastRoute = shouldUseDirectMessageFastPath({ modelTask, conversationId })
    ? classifyFastChat(content)
    : { kind: "agent" as const };
  if (fastRoute.kind !== "agent") {
    const selection = latest.modelRouting?.general ?? { providerId: latest.modelProvider ?? "nebius", model: latest.model };
    if (fastRoute.kind === "static" || selection.providerId === "ollama") {
      return executeFastChatTurn(latest, conversationId, content, fastRoute.kind === "static" ? fastRoute.reply : null, onProgress);
    }
  }
  const k = key(conversationId, latest.id);
  const folder = new TurnFolder(conversationId, latest, route, onProgress);
  setRunning(conversationId, latest.id, true);
  state.folders.set(k, folder);
  await saveMessage(folder.message);
  publish({ type: "message", message: folder.message });

  let unsubscribe: (() => void) | undefined;
  try {
    const session = await sessionFor(latest, conversationId);
    const resolution = await resolveModelForBot(latest, modelTask);
    // Preserve the selection for approval/suspension continuations where the
    // framework may not propagate the original RequestContext.
    const runtime = state.runtimes.get(latest.id);
    if (runtime) runtime.holder.resolution = resolution;
    folder.setModelResolution(resolution);
    const requestContext = new RequestContext();
    requestContext.set(MODEL_REQUEST_CONTEXT_KEY, resolution);
    let eventQueue = Promise.resolve();
    unsubscribe = session.subscribe((event) => {
      eventQueue = eventQueue.then(() => folder.handle(event)).catch(async (error) => {
        console.error("[opencrewbot] Could not process an agent event.", error);
        if (event.type === "tool_approval_required") {
          folder.failApprovalPersistence(event.toolCallId);
          try {
            await session.respondToToolApproval({ toolCallId: event.toolCallId, decision: "decline" });
          } catch (declineError) {
            console.error("[opencrewbot] Could not safely decline an unpersisted approval.", declineError);
            session.abort();
          }
        } else {
          await folder.finish("error", "The agent event could not be saved.");
        }
      });
    });
    await session.sendMessage({ content, requestContext });
    await eventQueue;
    // The run settled. If no terminal event reached us and nothing waits on the
    // person, close the turn here so it never hangs as "streaming".
    if (!folder.finished && !folder.waitingOnPerson()) await folder.finish("done");
    return await folder.done;
  } catch (error) {
    await folder.finish("error", error instanceof Error ? error.message : String(error));
    return folder.message;
  } finally {
    unsubscribe?.();
    if (state.folders.get(k) === folder) state.folders.delete(k);
    setRunning(conversationId, latest.id, false);
  }
}

export async function respondToApproval(conversationId: ConversationId, botId: string, toolCallId: string, approve: boolean) {
  const k = key(conversationId, botId);
  const session = state.sessions.get(k);
  const folder = state.folders.get(k);
  const request = await getApprovalRequest(conversationId, botId, toolCallId);
  if (!request) throw new InputError("That approval request does not exist.");
  if (request.status !== "pending") throw new InputError(`That request is already ${request.status}.`);
  if (!session || !folder || !folder.waitingForApproval(toolCallId)) {
    await cancelApprovalRequest(conversationId, botId, toolCallId, "inactive-request");
    throw new InputError("That request is no longer active and cannot be approved.");
  }
  const result = await decideApprovalRequest(conversationId, botId, toolCallId, approve);
  if (result.reason) {
    throw new InputError(
      result.reason === "expired"
        ? "That approval request has expired."
        : result.reason === "cancelled"
          ? "That approval request was cancelled."
          : result.reason === "not_found"
            ? "That approval request does not exist."
            : "That approval request has already been decided.",
    );
  }
  folder.approval(toolCallId, approve);
  let resumed: Awaited<ReturnType<Session["respondToToolApproval"]>>;
  try {
    resumed = await session.respondToToolApproval({ toolCallId, decision: approve ? "approve" : "decline" });
  } catch (error) {
    console.error("[opencrewbot] Mastra failed while resuming an approval.", error);
    if (approve) {
      try {
        await markApprovalOutcomeUnknown(conversationId, botId, toolCallId);
      } catch (persistenceError) {
        console.error("[opencrewbot] Could not persist the unknown approval outcome.", persistenceError);
      }
      folder.approvalOutcomeUnknown(toolCallId);
    } else {
      folder.approval(toolCallId, false);
    }
    try {
      session.abort();
    } catch (abortError) {
      console.error("[opencrewbot] Could not abort the failed approval flow.", abortError);
    }
    await folder.finish(
      "error",
      approve
        ? "The action may have run, but its outcome could not be confirmed. Reconcile before retrying."
        : "The action was rejected and was not run.",
    );
    throw new Error("The approval flow could not be resumed.");
  }
  if (!resumed.accepted) {
    await failApprovalResume(conversationId, botId, toolCallId);
    folder.approval(toolCallId, false);
    await folder.finish("error", "The action could not be resumed, so it was not run.");
    throw new InputError("That approval request could not be resumed; the action was not run.");
  }
}

export async function answerQuestion(conversationId: ConversationId, botId: string, toolCallId: string, answer: string) {
  const k = key(conversationId, botId);
  const session = state.sessions.get(k);
  if (!session) throw new Error("That question is no longer waiting. The bot may have restarted.");
  state.folders.get(k)?.answer(toolCallId, answer);
  await session.respondToToolSuspension({ toolCallId, resumeData: answer });
}

export async function stopConversation(conversationId: ConversationId) {
  state.stopEpoch.set(conversationId, (state.stopEpoch.get(conversationId) ?? 0) + 1);
  await cancelPendingApprovalRequests("conversation-stopped", conversationId);
  for (const [k, session] of state.sessions) {
    if (!k.startsWith(`${conversationId}|`)) continue;
    const folder = state.folders.get(k);
    try {
      session.abort();
    } catch {
      // nothing running
    }
    // A run parked on an approval or question has no live stream to abort.
    if (folder && !folder.finished) await folder.finish("stopped");
  }
}

/** Forget a bot's controller, e.g. after it's deleted or its settings change. */
export async function resetBot(botId: string) {
  if (!isBotBusy(botId)) await dropRuntime(botId);
}

/** Drop cached sessions so the next turn starts a fresh model-side thread. */
export function forgetConversation(conversationId: ConversationId) {
  for (const k of [...state.sessions.keys()]) if (k.startsWith(`${conversationId}|`)) state.sessions.delete(k);
}
