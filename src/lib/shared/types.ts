// Types shared by the server and the browser. Everything here is plain JSON.

export type ApprovalMode = "restricted" | "ask" | "full";

export interface BotTools {
  /** Tavily search, extract and crawl. */
  webSearch: boolean;
  /** Read and update the bot's MEMORY.md. */
  memory: boolean;
  /** Let the model write one TypeScript function that calls several tools at once. */
  codeMode: boolean;
  /** A real browser (Playwright) the bot can drive. */
  browser: boolean;
  /** The bot may stop and ask you a question with a card in chat. */
  askUser: boolean;
}

export interface Bot {
  id: string;
  name: string;
  /** Lowercase handle used for @mentions in rooms. */
  handle: string;
  title: string;
  description: string;
  instructions: string;
  emoji: string;
  color: string;
  model: string;
  tools: BotTools;
  /** Connection ids this bot may use: `composio:<toolkit>` or `mcp:<serverId>`. */
  connections: string[];
  approval: ApprovalMode;
  pinned: boolean;
  createdAt: string;
}

export type BotInput = Omit<Bot, "id" | "createdAt" | "handle" | "connections"> & { handle?: string; connections?: string[] };

export type RoomResponder = "auto" | "lead" | "everyone";

export interface Room {
  id: string;
  name: string;
  topic: string;
  emoji: string;
  memberIds: string[];
  leadId: string | null;
  responder: RoomResponder;
  pinned: boolean;
  createdAt: string;
}

export type RoomInput = Omit<Room, "id" | "createdAt">;

/** `dm:<botId>` or `room:<roomId>`. */
export type ConversationId = string;

export interface Source {
  title: string;
  url: string;
}

export type ToolStatus = "running" | "awaiting-approval" | "done" | "error" | "denied";

export type Part =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      name: string;
      label: string;
      detail?: string;
      status: ToolStatus;
      preview?: string;
      sources?: Source[];
    }
  | {
      kind: "question";
      toolCallId: string;
      question: string;
      options: { label: string; description?: string }[];
      answer?: string;
    };

export type MessageStatus = "streaming" | "done" | "error" | "stopped";

export interface RouteNote {
  by: "mention" | "jev" | "lead" | "everyone" | "handoff";
  confidence?: number;
}

export interface ChatMessage {
  id: string;
  conversationId: ConversationId;
  role: "user" | "bot" | "notice";
  botId?: string;
  createdAt: string;
  status: MessageStatus;
  parts: Part[];
  model?: string;
  usage?: { input: number; output: number; costUsd: number | null };
  route?: RouteNote;
  error?: string;
}

export interface ConversationSummary {
  id: ConversationId;
  lastMessage?: { text: string; createdAt: string; author: string };
  running: string[];
  unread: number;
}

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  context: number;
  tools: boolean;
  reasoning: boolean;
  vision: boolean;
  inputPerM: number | null;
  outputPerM: number | null;
  live: boolean;
}

export interface AppStatus {
  mock: boolean;
  keys: { nebius: boolean; tavily: boolean; jev: boolean; browserbase: boolean; composio: boolean };
  ollama: { available: boolean; baseUrl: string; defaultModel: string };
  dataDir: string;
}

/** Events the server pushes to the browser over one SSE stream. */
export type ServerEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "delta"; conversationId: ConversationId; messageId: string; partIndex: number; kind: "text" | "reasoning"; delta: string }
  | { type: "running"; conversationId: ConversationId; botIds: string[] }
  | { type: "bots-changed" }
  | { type: "rooms-changed" }
  | { type: "memory-changed"; botId: string }
  | { type: "room-memory-changed"; roomId: string }
  /** A bot's Browserbase live view opened (url) or closed (null). */
  | { type: "browser-session"; botId: string; liveUrl: string | null }
  | { type: "connections-changed" }
  | { type: "schedules-changed" };

/** An app from Composio's catalog, with this install's connection state. */
export interface ComposioApp {
  slug: string;
  name: string;
  logo?: string;
  connected: boolean;
}

/** A remote MCP server you added. The token never leaves the server. */
export interface McpServer {
  id: string;
  name: string;
  url: string;
  hasToken: boolean;
  headerNames: string[];
}

export interface GithubRepoSummary {
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  visibility: "public" | "private";
  default_branch: string;
  html_url: string;
}

export interface GithubConnectionStatus {
  configured: boolean;
  source: "env" | "mcp" | "composio" | "none";
  login?: string;
  scopes?: string[];
  error?: string;
}

export interface ConnectionsState {
  composio: { enabled: boolean; apps: ComposioApp[]; error?: string };
  mcpServers: McpServer[];
  github?: GithubConnectionStatus;
}

/** Something a bot can be given access to. */
export interface ConnectionOption {
  id: string;
  name: string;
  kind: "composio" | "mcp" | "github";
  logo?: string;
}

export interface PendingApproval {
  conversationId: ConversationId;
  messageId: string;
  botId: string;
  botName: string;
  toolCallId: string;
  name: string;
  label: string;
  detail?: string;
  createdAt: string;
  live: boolean;
}

export type ScheduleRecurrence = "once" | "interval" | "daily" | "weekly";

export type ScheduleTarget =
  | { kind: "dm"; botId: string }
  | { kind: "room"; roomId: string };

export interface ScheduledWorkflow {
  id: string;
  name: string;
  target: ScheduleTarget;
  prompt: string;
  recurrence: ScheduleRecurrence;
  intervalMinutes?: number;
  nextRunAt: string;
  enabled: boolean;
  maxRetries: number;
  retryCount: number;
  lastRunAt?: string;
  lastStatus?: "running" | "success" | "failed";
  lastError?: string;
  createdAt: string;
}

export interface ScheduleInput {
  name: string;
  target: ScheduleTarget;
  prompt: string;
  recurrence: ScheduleRecurrence;
  intervalMinutes?: number;
  nextRunAt: string;
  enabled?: boolean;
  maxRetries?: number;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  scheduleName: string;
  conversationId: ConversationId;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "success" | "failed";
  attempt: number;
  willRetry: boolean;
  error?: string;
  simulated?: boolean;
  messageIds?: string[];
}

export interface SkillDefinitionSummary {
  id: string;
  name: string;
  category: string;
  description: string;
  recommendedRole: string;
  sampleInput: Record<string, unknown>;
}

export interface SkillExecutionResult {
  skillId: string;
  skillName: string;
  ok: boolean;
  summary: string;
  deliverable: Record<string, unknown>;
  markdown: string;
}

export interface DelegationTaskRecord {
  id: string;
  title: string;
  botId: string;
  botName: string;
  botHandle: string;
  dependsOn: string[];
  status: "pending" | "running" | "done" | "error" | "blocked" | "stopped";
  outcome: "pending" | "running" | "completed" | "failed" | "blocked" | "stopped";
  startedAt?: string;
  finishedAt?: string;
  recoveredFrom?: { botId: string; botName: string; error: string };
  output?: string;
  error?: string;
  messageId?: string;
}

export interface DelegationRunRecord {
  id: string;
  roomId: string;
  roomName: string;
  requestedByBotId: string;
  createdAt: string;
  finishedAt?: string;
  ok: boolean;
  tasks: DelegationTaskRecord[];
}

