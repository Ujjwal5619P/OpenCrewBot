// Types shared by the server and the browser. Everything here is plain JSON.

export type ApprovalMode = "ask" | "controlled" | "full";

export type ApprovalRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired"
  | "failed"
  | "outcome_unknown";

export interface ApprovalRequest {
  id: string;
  conversationId: ConversationId;
  botId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  action: string;
  details: string;
  status: ApprovalRequestStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decisionBy?: string;
  executionId?: string;
  taskId?: string;
}

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
  /** Missing on legacy records; defaults to Nebius Token Factory. */
  modelProvider?: ModelProviderId;
  fallbackModel?: ModelSelection;
  modelRouting?: Partial<Record<ModelTaskType, ModelSelection>>;
  tools: BotTools;
  /** Connection ids this bot may use: `composio:<toolkit>` or `mcp:<serverId>`. */
  connections: string[];
  /** Reusable skills enabled for this bot. Missing on legacy bot records. */
  skillIds?: string[];
  approval: ApprovalMode;
  /** Exact registered tool IDs that Controlled Access may auto-approve, subject to sensitive-action checks. */
  approvalPermissions?: string[];
  pinned: boolean;
  createdAt: string;
}

export type BotInput = Omit<Bot, "id" | "createdAt" | "handle" | "connections" | "fallbackModel"> & {
  handle?: string;
  connections?: string[];
  fallbackModel?: ModelSelection | null;
};

export interface AgentConfiguration {
  name: string;
  title: string;
  description: string;
  instructions: string;
  model: string;
  modelProvider?: ModelProviderId;
  tools: BotTools;
  skills: string[];
  memory: { enabled: boolean; guidance: string };
  approval: ApprovalMode;
  approvalPermissions: { browserActions: "ask"; connectedAppActions: "ask" };
  expectedOutputFormat: string;
}

export interface AgentConfigurationResult {
  configuration: AgentConfiguration;
  botInput: BotInput;
  mode: "live" | "simulated";
  label: string;
  unavailableTools: ("webSearch" | "browser")[];
}

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

export type ToolStatus = "running" | "awaiting-approval" | "done" | "error" | "denied" | "outcome_unknown";

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
  usage?: {
    input: number | null;
    output: number | null;
    costUsd: number | null;
    provider: ModelProviderId | "mock";
    model: string;
    requestedAt: string;
    simulated: boolean;
    fallbackFrom?: ModelSelection;
  };
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
  /** Model family or upstream publisher, retained for the picker. */
  provider: string;
  providerId: ModelProviderId;
  context: number;
  tools: boolean;
  reasoning: boolean;
  vision: boolean;
  inputPerM: number | null;
  outputPerM: number | null;
  live: boolean;
  available: boolean;
}

export type ModelProviderId = "nebius" | "ollama";
export type ModelTaskType = "general" | "research" | "coding" | "data_analysis" | "planning";

export interface ModelSelection {
  providerId: ModelProviderId;
  model: string;
}

export interface ModelProviderStatus {
  providerId: ModelProviderId;
  label: string;
  available: boolean;
  configured: boolean;
  message?: string;
}

export interface ModelUsageSummary {
  provider: ModelProviderId | "mock";
  model: string;
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  unknownInputRequests: number;
  unknownOutputRequests: number;
  unknownCostRequests: number;
  simulatedRequests: number;
  fallbackRequests: number;
  lastRequestedAt: string;
}

export interface AppStatus {
  mock: boolean;
  keys: { nebius: boolean; tavily: boolean; jev: boolean; browserbase: boolean; composio: boolean };
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
  | { type: "project-memory-changed" }
  /** A bot's Browserbase live view opened (url) or closed (null). */
  | { type: "browser-session"; botId: string; liveUrl: string | null }
  | { type: "connections-changed" };

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

export interface ConnectionsState {
  composio: { enabled: boolean; apps: ComposioApp[]; error?: string };
  mcpServers: McpServer[];
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  requiredTools: string[];
}

export type ComposioDiscoveryStatus = "connected" | "disconnected" | "unavailable" | "error";

export interface ComposioDiscoveredTool {
  toolSlug: string;
  toolkit: string;
  description: string;
}

export interface ComposioToolDiscovery {
  slug: string;
  status: ComposioDiscoveryStatus;
  message?: string;
  tools: ComposioDiscoveredTool[];
}

/** Something a bot can be given access to. */
export interface ConnectionOption {
  id: string;
  name: string;
  kind: "composio" | "mcp";
  logo?: string;
}

export type ExecutionTaskStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "outcome_unknown"
  | "cancelled";
export type ExecutionStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type PlannerMode = "ai" | "simulated";
export type TaskCapability =
  | "research"
  | "writing"
  | "planning"
  | "analysis"
  | "webSearch"
  | "memory"
  | "codeMode"
  | "browser"
  | "connectedApps"
  | "askUser";

export interface ExecutionTask {
  id: string;
  title: string;
  description: string;
  assignedBotId: string;
  requiredCapabilities: TaskCapability[];
  dependencies: string[];
  status: ExecutionTaskStatus;
  output?: string;
  error?: string;
  approvalRequest?: { conversationId: ConversationId; toolCallId: string };
  inputRequest?: {
    conversationId: ConversationId;
    toolCallId: string;
    question: string;
    options: { label: string; description?: string }[];
  };
  sideEffectsPossible?: boolean;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  retryCount: number;
  approvalRequired: boolean;
  collaboration?: {
    objective: string;
    context: string;
    expectedOutput: string;
    verificationOfTaskId?: string;
    verificationStatus?: "accepted" | "needs_revision" | "inconclusive";
  };
}

export interface Execution {
  id: string;
  instruction: string;
  summary: string;
  plannerMode: PlannerMode;
  plannerLabel: string;
  status: ExecutionStatus;
  tasks: ExecutionTask[];
  output?: string;
  error?: string;
  scheduleId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  collaboration?: {
    roomId: string;
    parentExecutionId?: string;
    rootExecutionId: string;
    depth: number;
    delegatorBotId: string;
    path: string[];
    patternKey?: string;
  };
}

export type WorkflowRecurrence = "once" | "daily" | "weekly";
export type ScheduledWorkflowStatus = "active" | "paused" | "completed" | "deleted";
export type ScheduledWorkflowRunStatus = "claimed" | "running" | "completed" | "failed" | "outcome_unknown" | "cancelled" | "skipped";

export interface ScheduledWorkflowPlan {
  instruction: string;
  summary: string;
  plannerMode: PlannerMode;
  plannerLabel: string;
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    assignedBotId: string;
    requiredCapabilities: TaskCapability[];
    dependencies: string[];
  }>;
}

export interface ScheduledWorkflow {
  id: string;
  name: string;
  recurrence: WorkflowRecurrence;
  timeZone: string;
  localTime: string;
  oneTimeLocal?: string;
  weekdays: number[];
  status: ScheduledWorkflowStatus;
  nextRunAt: string | null;
  lastRunAt?: string;
  lastExecutionId?: string;
  plan: ScheduledWorkflowPlan;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledWorkflowRun {
  id: string;
  workflowId: string;
  occurrenceKey: string;
  scheduledFor: string;
  executionId?: string;
  status: ScheduledWorkflowRunStatus;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  plan: ScheduledWorkflowPlan;
}

export type CollaborationMessageType =
  | "delegation"
  | "delegation_rejected"
  | "task_output"
  | "research"
  | "question"
  | "answer"
  | "verification_request"
  | "verification_result";

export interface CollaborationMessage {
  id: string;
  roomId: string;
  executionId?: string;
  taskId?: string;
  type: CollaborationMessageType;
  authorBotId: string;
  recipientBotId?: string;
  responseToMessageId?: string;
  content: string;
  createdAt: string;
}

export interface CollaborationTaskSpec {
  id: string;
  title: string;
  objective: string;
  context: string;
  expectedOutput: string;
  assignedBotId: string;
  dependencies: string[];
  verificationOfTaskId?: string;
}
