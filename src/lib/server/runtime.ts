// The agent harness glue. Mastra's AgentController owns the agent loop,
// sessions, thread history, tool approvals and ask-user suspensions. This file
// gives each bot one controller, each conversation one session, and folds the
// controller's events into the chat messages the UI renders.
import { Agent } from "@mastra/core/agent";
import { AgentController, type AgentControllerEvent, type Session } from "@mastra/core/agent-controller";
import type { MastraBrowser } from "@mastra/core/browser";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { RequestContext } from "@mastra/core/request-context";
import { randomUUID } from "node:crypto";
import type { Bot, ChatMessage, ConversationId, Part, PendingApproval, RouteNote } from "@/lib/shared/types";
import { DEFAULT_OLLAMA_MODEL, MASTRA_DB_URL, OWNER_ID, isOllamaReachable, keys, ollamaBaseUrl } from "./config";
import { conversationGeneration, findToolPartByCallId, getBot, listAwaitingApprovalMessages, listBots, saveMessage } from "./db";
import { InputError } from "./errors";
import { publish } from "./bus";
import { costUsd, findModel } from "./models";
import { createMockModel } from "./mock-model";
import { announceLiveView, createSession, releaseSession } from "./browserbase";
import { buildConnectorTools, connectionsVersion } from "./connectors";
import { systemPrompt } from "./prompt";
import { buildTools, toolCategory, toolLabel, toolPreview, toolSources } from "./tools";

// ── shared state that must survive Next.js hot reloads ─────────────────

interface BotRuntime {
  signature: string;
  /** The latest saved bot; the system prompt reads it on every model call. */
  holder: { bot: Bot };
  controller: AgentController;
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
  /** `${conversationId}|${toolCallId}` → resolved approval decision to block retries/replays */
  resolvedApprovals: Map<string, "approved" | "denied">;
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
  resolvedApprovals: new Map(),
});
state.resolvedApprovals ??= new Map();

const key = (conversationId: ConversationId, botId: string) => `${conversationId}|${botId}`;

// ── one controller per bot ──────────────────────────────────────────────

async function resolveBotModel(bot: Bot) {
  const ollamaReady = await isOllamaReachable();
  if (bot.model.startsWith("ollama/")) {
    if (ollamaReady) {
      return {
        mode: "ollama" as const,
        modelId: bot.model,
        config: {
          providerId: "ollama",
          modelId: bot.model.slice("ollama/".length),
          url: `${ollamaBaseUrl()}/v1`,
          apiKey: process.env.OLLAMA_API_KEY || "ollama",
        },
      };
    }
    return { mode: "mock" as const, modelId: "mock", config: createMockModel(bot.name) };
  }
  if (keys.nebius()) {
    return { mode: "nebius" as const, modelId: bot.model, config: `nebius/${bot.model}` };
  }
  if (ollamaReady) {
    return {
      mode: "ollama" as const,
      modelId: `ollama/${DEFAULT_OLLAMA_MODEL}`,
      config: {
        providerId: "ollama",
        modelId: DEFAULT_OLLAMA_MODEL,
        url: `${ollamaBaseUrl()}/v1`,
        apiKey: process.env.OLLAMA_API_KEY || "ollama",
      },
    };
  }
  return { mode: "mock" as const, modelId: "mock", config: createMockModel(bot.name) };
}

/** Settings that need a new controller when they change. Persona text doesn't:
 * the system prompt is rebuilt from the latest bot on every model call. */
async function signatureOf(bot: Bot): Promise<string> {
  // The model isn't here: it's read from the latest bot on every call, so a
  // model switch applies to the next reply without dropping any sessions.
  // Connections are, along with a version that bumps when any app or server changes.
  return JSON.stringify({
    tools: bot.tools,
    approval: bot.approval,
    connections: bot.connections,
    connectionsVersion: await connectionsVersion(),
    nebius: keys.nebius(),
    github: keys.github(),
    ollama: await isOllamaReachable(),
  });
}

/** A Browserbase cloud browser, reached over CDP. The session starts on the
 * bot's first browser action and is released when its controller closes. */
async function createBrowser(bot: Bot): Promise<MastraBrowser | undefined> {
  if (!bot.tools.browser) return undefined;
  const { AgentBrowser } = await import("@mastra/agent-browser");
  const model = keys.nebius() ? await findModel(bot.model) : undefined;
  return new AgentBrowser({
    cdpUrl: () => createSession(bot.id),
    scope: "shared",
    onLaunch: () => announceLiveView(bot.id),
    onClose: () => releaseSession(bot.id),
    // A screenshot comes back as an image, which text-only models can't read.
    excludeTools: model?.vision ? [] : ["browser_screenshot"],
  }) as unknown as MastraBrowser;
}

async function buildRuntime(bot: Bot): Promise<BotRuntime> {
  const holder = { bot };
  const memory = new Memory({ storage: state.storage, options: { lastMessages: 40 } });
  const builtIn = buildTools(bot);
  const connectors = await buildConnectorTools(bot, `bot-${bot.id}-${Date.now()}`);
  const capabilities = [...builtIn.capabilities, ...connectors.capabilities];
  const agent = new Agent({
    id: `bot-${bot.id}`,
    name: bot.name,
    instructions: () => systemPrompt(holder.bot, capabilities, builtIn.instructions),
    model: async () => (await resolveBotModel(holder.bot)).config,
    tools: { ...connectors.tools, ...builtIn.tools },
    memory,
    defaultOptions: { maxSteps: 10 },
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
  return { signature: await signatureOf(bot), holder, controller, ready: controller.init(), closeConnectors: connectors.close };
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
  const threadId = `${conversationId}:${bot.id}:${generation}`;
  const k = key(conversationId, bot.id);
  const cached = state.sessions.get(k);
  if (cached && cached.thread.getId() === threadId) return cached;
  const requestContext = new RequestContext();
  requestContext.set("conversationId", conversationId);
  const session = await runtime.controller.createSession({ resourceId: OWNER_ID, scope: conversationId, threadId, requestContext });
  await session.permissions.setForCategory({ category: "read", policy: "allow" });
  await session.permissions.setForCategory({ category: "edit", policy: bot.approval === "restricted" ? "deny" : "allow" });
  await session.permissions.setForCategory({ category: "other", policy: "allow" });
  // Restricted blocks mutations/external actions; Ask prompts first; Full allows without asking.
  const externalPolicy = bot.approval === "full" ? "allow" : bot.approval === "restricted" ? "deny" : "ask";
  await session.permissions.setForCategory({ category: "mcp", policy: externalPolicy });
  await session.permissions.setForCategory({ category: "execute", policy: externalPolicy });
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
  private toolNameByCallId = new Map<string, string>();
  private toolErrorCounts = new Map<string, number>();
  private totalToolErrors = 0;
  private onRepeatedToolError?: (reason: string) => void;
  private input = 0;
  private output = 0;
  private resolveDone!: (m: ChatMessage) => void;
  readonly done = new Promise<ChatMessage>((r) => (this.resolveDone = r));
  finished = false;

  constructor(
    conversationId: ConversationId,
    bot: Bot,
    modelId: string,
    route?: RouteNote,
    onRepeatedToolError?: (reason: string) => void,
  ) {
    this.onRepeatedToolError = onRepeatedToolError;
    this.message = {
      id: randomUUID(),
      conversationId,
      role: "bot",
      botId: bot.id,
      createdAt: new Date().toISOString(),
      status: "streaming",
      parts: [],
      model: modelId,
      route,
    };
  }

  private emit(persist = false) {
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

  handle(event: AgentControllerEvent) {
    if (this.finished) return;
    switch (event.type) {
      case "message_update": {
        if (event.event.type === "text-delta") this.streamInto("text", event.id, event.event.delta);
        else if (event.event.type === "reasoning-delta") this.streamInto("reasoning", event.id, event.event.delta);
        break;
      }
      case "tool_start": {
        this.toolNameByCallId.set(event.toolCallId, event.toolName);
        if (event.toolName === "ask_user" || this.toolPart.has(event.toolCallId)) break;
        const { label, detail } = toolLabel(event.toolName, event.args);
        this.message.parts.push({ kind: "tool", toolCallId: event.toolCallId, name: event.toolName, label, detail, status: "running" });
        this.toolPart.set(event.toolCallId, this.message.parts.length - 1);
        this.emit(true);
        break;
      }
      case "tool_approval_required": {
        this.toolNameByCallId.set(event.toolCallId, event.toolName);
        let part = this.tool(event.toolCallId);
        if (!part) {
          const { label, detail } = toolLabel(event.toolName, event.args);
          this.message.parts.push({ kind: "tool", toolCallId: event.toolCallId, name: event.toolName, label, detail, status: "awaiting-approval" });
          this.toolPart.set(event.toolCallId, this.message.parts.length - 1);
          part = this.tool(event.toolCallId);
        }
        part!.status = "awaiting-approval";
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
        const resultObj = event.result && typeof event.result === "object" ? (event.result as Record<string, unknown>) : null;
        const isFailure =
          !event.denied &&
          (event.isError ||
            Boolean(resultObj && (resultObj.error === true || resultObj.isError === true || typeof resultObj.error === "string")));
        if (part) {
          part.status = event.denied ? "denied" : isFailure ? "error" : "done";
          part.preview = toolPreview(event.result);
          part.sources = toolSources(event.result);
          this.emit(true);
        }
        if (isFailure) {
          const toolName = part?.name ?? this.toolNameByCallId.get(event.toolCallId) ?? "tool";
          const count = (this.toolErrorCounts.get(toolName) ?? 0) + 1;
          this.toolErrorCounts.set(toolName, count);
          this.totalToolErrors += 1;
          if (count >= 2 || this.totalToolErrors >= 3) {
            const detail = part?.preview ? `: ${part.preview}` : "";
            this.onRepeatedToolError?.(
              `Stopped repeated failing tool call "${toolName}" after ${count} error(s)${detail}. Fix arguments or configure the required integration before retrying.`,
            );
          }
        }
        break;
      }
      case "usage_update": {
        const u = event.usage as { promptTokens?: number; completionTokens?: number };
        this.input += u.promptTokens ?? 0;
        this.output += u.completionTokens ?? 0;
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
        p.status = status === "stopped" ? "denied" : "error";
      }
    }
    if (this.message.model !== "mock") {
      const model = await findModel(this.message.model ?? "");
      this.message.usage = { input: this.input, output: this.output, costUsd: costUsd(model, this.input, this.output) };
    } else {
      this.message.usage = { input: this.input, output: this.output, costUsd: null };
    }
    await saveMessage(this.message);
    publish({ type: "message", message: this.message });
    this.resolveDone(this.message);
  }
}

// ── public API ──────────────────────────────────────────────────────────

export interface TurnRequest {
  bot: Bot;
  conversationId: ConversationId;
  /** What the bot receives: the person's words, or a room's catch-up text. */
  content: string;
  route?: RouteNote;
}

/** Queue one turn for one bot in one conversation and resolve with its reply,
 * or null when Stop cancelled it before it started. */
export function runTurn(request: TurnRequest): Promise<ChatMessage | null> {
  const k = key(request.conversationId, request.bot.id);
  const epoch = state.stopEpoch.get(request.conversationId) ?? 0;
  const previous = state.chains.get(k) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => ((state.stopEpoch.get(request.conversationId) ?? 0) === epoch ? executeTurn(request) : null));
  state.chains.set(k, next);
  void next.finally(() => {
    if (state.chains.get(k) === next) state.chains.delete(k);
  });
  return next;
}

const TURN_TIMEOUT_MS = Math.max(5_000, Number(process.env.OPENCREWBOT_TURN_TIMEOUT_MS || 90_000));

async function executeTurn({ bot, conversationId, content, route }: TurnRequest): Promise<ChatMessage> {
  const latest = (await getBot(bot.id)) ?? bot;
  const resolved = await resolveBotModel(latest);
  const k = key(conversationId, latest.id);
  let abortCircuit: ((err: Error) => void) | undefined;
  const circuitPromise = new Promise<never>((_, reject) => {
    abortCircuit = reject;
  });
  let activeSession: Session | undefined;
  const folder = new TurnFolder(conversationId, latest, resolved.modelId, route, (reason) => {
    try {
      activeSession?.abort();
    } catch {
      // ignore abort failure
    }
    abortCircuit?.(new Error(reason));
  });
  setRunning(conversationId, latest.id, true);
  state.folders.set(k, folder);
  await saveMessage(folder.message);
  publish({ type: "message", message: folder.message });

  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const session = await sessionFor(latest, conversationId);
    activeSession = session;
    const requestContext = new RequestContext();
    requestContext.set("conversationId", conversationId);
    unsubscribe = session.subscribe((event) => folder.handle(event));

    const sendPromise = session.sendMessage({ content, requestContext });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (folder.waitingOnPerson() || folder.finished) return;
        try {
          session.abort();
        } catch {
          // ignore abort failure
        }
        reject(new Error(`Turn timed out after ${Math.round(TURN_TIMEOUT_MS / 1000)}s waiting for ${resolved.modelId}.`));
      }, TURN_TIMEOUT_MS);
    });

    await Promise.race([sendPromise, timeoutPromise, circuitPromise]);
    // The run settled. If no terminal event reached us and nothing waits on the
    // person, close the turn here so it never hangs as "streaming".
    if (!folder.finished && !folder.waitingOnPerson()) await folder.finish("done");
    return await folder.done;
  } catch (error) {
    await folder.finish("error", error instanceof Error ? error.message : String(error));
    return folder.message;
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe?.();
    if (state.folders.get(k) === folder) state.folders.delete(k);
    setRunning(conversationId, latest.id, false);
  }
}

export async function listPendingApprovals(): Promise<PendingApproval[]> {
  const [messages, bots] = await Promise.all([listAwaitingApprovalMessages(), listBots()]);
  const botNames = new Map(bots.map((b) => [b.id, b.name]));
  const items: PendingApproval[] = [];
  for (const m of messages) {
    if (m.status !== "streaming" || !m.botId) continue;
    for (const p of m.parts) {
      if (p.kind !== "tool" || p.status !== "awaiting-approval") continue;
      const approvalKey = `${m.conversationId}|${p.toolCallId}`;
      if (state.resolvedApprovals.has(approvalKey)) continue;
      items.push({
        conversationId: m.conversationId,
        messageId: m.id,
        botId: m.botId,
        botName: botNames.get(m.botId) ?? "Bot",
        toolCallId: p.toolCallId,
        name: p.name,
        label: p.label,
        detail: p.detail,
        createdAt: m.createdAt,
        live: state.sessions.has(key(m.conversationId, m.botId)),
      });
    }
  }
  return items;
}

export async function respondToApproval(conversationId: ConversationId, botId: string, toolCallId: string, approve: boolean) {
  const approvalKey = `${conversationId}|${toolCallId}`;
  const prior = state.resolvedApprovals.get(approvalKey);
  if (prior) {
    throw new InputError(
      prior === "denied"
        ? "This action was rejected and is permanently blocked from executing."
        : "This approval request has already been resolved.",
    );
  }

  const persisted = await findToolPartByCallId(conversationId, toolCallId);
  if (persisted) {
    if (persisted.status === "denied") {
      state.resolvedApprovals.set(approvalKey, "denied");
      throw new InputError("This action was rejected and is permanently blocked from executing.");
    }
    if (persisted.status !== "awaiting-approval") {
      throw new InputError(`This action is already in "${persisted.status}" status and cannot be re-executed.`);
    }
  }

  const session = state.sessions.get(key(conversationId, botId));
  if (!session) {
    if (!approve && persisted?.status === "awaiting-approval") {
      state.resolvedApprovals.set(approvalKey, "denied");
      const msg = persisted.message;
      for (const p of msg.parts) {
        if (p.kind === "tool" && p.toolCallId === toolCallId) {
          p.status = "denied";
          p.preview = "Rejected by user while session was inactive.";
        }
      }
      msg.status = "stopped";
      await saveMessage(msg);
      publish({ type: "message", message: msg });
      return;
    }
    throw new InputError("That approval request is no longer active because the session restarted or closed.");
  }

  state.resolvedApprovals.set(approvalKey, approve ? "approved" : "denied");
  await session.respondToToolApproval({ toolCallId, decision: approve ? "approve" : "decline" });
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
