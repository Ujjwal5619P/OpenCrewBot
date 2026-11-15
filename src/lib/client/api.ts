import type {
  AppStatus,
  AgentConfigurationResult,
  ApprovalRequest,
  Bot,
  BotInput,
  ChatMessage,
  ComposioApp,
  ComposioToolDiscovery,
  ConnectionsState,
  CollaborationMessage,
  ConversationId,
  ConversationSummary,
  Execution,
  McpServer,
  ModelOption,
  ModelProviderStatus,
  ModelUsageSummary,
  Room,
  RoomInput,
  ScheduledWorkflow,
  ScheduledWorkflowRun,
  SkillSummary,
  WorkflowRecurrence,
} from "@/lib/shared/types";

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const conv = (id: ConversationId) => `/api/conversations/${encodeURIComponent(id)}`;

export interface Bootstrap {
  status: AppStatus;
  bots: Bot[];
  rooms: Room[];
  conversations: ConversationSummary[];
  models: ModelOption[];
  modelProviders: ModelProviderStatus[];
  /** botId → Browserbase live view URL for bots with an open browser. */
  liveViews: Record<string, string>;
}

export interface ScheduledWorkflowDraft {
  name: string;
  instruction: string;
  recurrence: WorkflowRecurrence;
  timeZone: string;
  localTime?: string;
  oneTimeLocal?: string;
  weekdays?: number[];
}

export const api = {
  bootstrap: () => call<Bootstrap>("/api/bootstrap"),
  skills: () => call<{ skills: SkillSummary[] }>("/api/skills"),
  models: (refresh = false) =>
    call<{ models: ModelOption[]; providers: ModelProviderStatus[] }>(`/api/models${refresh ? "?refresh=1" : ""}`),
  modelUsage: () => call<{ usage: ModelUsageSummary[] }>("/api/model-usage"),
  createBot: (input: BotInput) => call<{ bot: Bot }>("/api/bots", { method: "POST", json: input }),
  generateAgent: (description: string) =>
    call<AgentConfigurationResult>("/api/bots/generate", { method: "POST", json: { description } }),
  updateBot: (id: string, patch: Partial<BotInput>) => call<{ bot: Bot }>(`/api/bots/${id}`, { method: "PATCH", json: patch }),
  deleteBot: (id: string) => call(`/api/bots/${id}`, { method: "DELETE" }),
  getMemory: (id: string) => call<{ content: string; path: string; limit: { lines: number; bytes: number } }>(`/api/bots/${id}/memory`),
  saveMemory: (id: string, content: string) => call<{ content: string }>(`/api/bots/${id}/memory`, { method: "PUT", json: { content } }),
  getProjectMemory: () =>
    call<{ content: string; path: string; authorizedBotIds: string[]; limit: { bytes: number; readBytes: number } }>("/api/project-memory"),
  saveProjectMemory: (content: string) =>
    call<{ content: string }>("/api/project-memory", { method: "PUT", json: { content } }),
  addProjectMemoryEntry: (entry: { note: string; section?: string; source: "user" | "project_decision"; confidence: "confirmed" | "unverified" }) =>
    call<{ content: string }>("/api/project-memory", { method: "POST", json: entry }),
  setProjectMemoryAccess: (authorizedBotIds: string[], expectedAuthorizedBotIds: string[]) =>
    call<{ authorizedBotIds: string[] }>("/api/project-memory", {
      method: "PATCH",
      json: { authorizedBotIds, expectedAuthorizedBotIds },
    }),
  createRoom: (input: RoomInput) => call<{ room: Room }>("/api/rooms", { method: "POST", json: input }),
  updateRoom: (id: string, patch: Partial<RoomInput>) => call<{ room: Room }>(`/api/rooms/${id}`, { method: "PATCH", json: patch }),
  deleteRoom: (id: string) => call(`/api/rooms/${id}`, { method: "DELETE" }),
  roomCollaboration: (id: string) =>
    call<{ executions: Execution[]; messages: CollaborationMessage[] }>(`/api/rooms/${id}/collaboration`),
  cancelExecution: (id: string) => call(`/api/executions/${id}/cancel`, { method: "POST" }),
  scheduledWorkflows: (options?: { workflowId: string; limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (options) {
      params.set("workflowId", options.workflowId);
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      if (options.offset !== undefined) params.set("offset", String(options.offset));
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return call<{
      workflows: ScheduledWorkflow[];
      runs: ScheduledWorkflowRun[];
      pagination: { workflowId: string; limit: number; offset: number; hasMore: boolean } | null;
    }>(`/api/scheduled-workflows${query}`);
  },
  createScheduledWorkflow: (input: ScheduledWorkflowDraft) =>
    call<{ workflow: ScheduledWorkflow }>("/api/scheduled-workflows", { method: "POST", json: input }),
  updateScheduledWorkflow: (id: string, input: ScheduledWorkflowDraft) =>
    call<{ workflow: ScheduledWorkflow }>(`/api/scheduled-workflows/${encodeURIComponent(id)}`, { method: "PATCH", json: input }),
  deleteScheduledWorkflow: (id: string) =>
    call<{ workflow: ScheduledWorkflow }>(`/api/scheduled-workflows/${encodeURIComponent(id)}`, { method: "DELETE" }),
  pauseScheduledWorkflow: (id: string) =>
    call<{ workflow: ScheduledWorkflow }>(`/api/scheduled-workflows/${encodeURIComponent(id)}/pause`, { method: "POST" }),
  resumeScheduledWorkflow: (id: string) =>
    call<{ workflow: ScheduledWorkflow }>(`/api/scheduled-workflows/${encodeURIComponent(id)}/resume`, { method: "POST" }),
  runScheduledWorkflow: (id: string) =>
    call<{ execution: Execution }>(`/api/scheduled-workflows/${encodeURIComponent(id)}/run`, { method: "POST" }),
  messages: (id: ConversationId) => call<{ messages: ChatMessage[]; running: string[] }>(`${conv(id)}/messages`),
  send: (id: ConversationId, text: string) => call<{ message: ChatMessage }>(`${conv(id)}/messages`, { method: "POST", json: { text } }),
  approve: (id: ConversationId, botId: string, toolCallId: string, approve: boolean) =>
    call(`${conv(id)}/approval`, { method: "POST", json: { botId, toolCallId, approve } }),
  approvals: () => call<{ requests: ApprovalRequest[] }>("/api/approvals"),
  answer: (id: ConversationId, botId: string, toolCallId: string, answer: string) =>
    call(`${conv(id)}/answer`, { method: "POST", json: { botId, toolCallId, answer } }),
  stop: (id: ConversationId) => call(`${conv(id)}/stop`, { method: "POST" }),
  clear: (id: ConversationId) => call(`${conv(id)}/clear`, { method: "POST" }),
  read: (id: ConversationId) => call(`${conv(id)}/read`, { method: "POST" }),
  connections: () => call<ConnectionsState>("/api/connections"),
  searchApps: (q: string) => call<{ apps: ComposioApp[] }>(`/api/connections/composio/search?q=${encodeURIComponent(q)}`),
  discoverComposioTools: (slug: string, query: string) =>
    call<{ discovery: ComposioToolDiscovery }>(
      `/api/connections/composio/tools?slug=${encodeURIComponent(slug)}&query=${encodeURIComponent(query)}`,
    ),
  connectApp: (slug: string) => call<{ redirectUrl: string }>("/api/connections/composio/connect", { method: "POST", json: { slug } }),
  disconnectApp: (slug: string) => call("/api/connections/composio/disconnect", { method: "POST", json: { slug } }),
  connectionsChanged: () => call("/api/connections/changed", { method: "POST" }),
  addMcpServer: (input: { name: string; url: string; token?: string; headers?: Record<string, string> }) =>
    call<{ server: McpServer }>("/api/connections/mcp", { method: "POST", json: input }),
  removeMcpServer: (id: string) => call(`/api/connections/mcp/${id}`, { method: "DELETE" }),
  testMcpServer: (id: string) => call<{ tools: number }>(`/api/connections/mcp/${id}/test`, { method: "POST" }),
};
