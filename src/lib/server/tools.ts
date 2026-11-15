// The tools a bot gets, from its settings. Names are short snake_case words
// because open models pick tools by name more reliably that way.
import type { ToolsInput } from "@mastra/core/agent";
import { createTool, createCodeMode } from "@mastra/core/tools";
import type { ToolCategory } from "@mastra/core/agent-controller";
import { createTavilyCrawlTool, createTavilyExtractTool, createTavilySearchTool } from "@mastra/tavily";
import { QuickJsCodeModeTransport } from "@mastra/quickjs";
import { z } from "zod";
import type { Bot, Source } from "@/lib/shared/types";
import { appendMemory, appendProjectMemoryEntry, editMemory, projectMemoryForAgent } from "./memory-files";
import { publish } from "./bus";
import { keys } from "./config";
import { mcpServerNames } from "./connectors";
import { canAccessProjectMemory } from "./project-memory";
import { toolsAllowedInCodeMode } from "./approval-core";
import { reusableSkillTools } from "./skills/tools";

export const CODE_MODE_TOOL = "execute_typescript";

function memoryTools(botId: string): ToolsInput {
  return {
    memory_add: createTool({
      id: "memory_add",
      description:
        "Save one durable fact to your MEMORY.md (a preference, a decision, something about the person or your ongoing work). One short line per call.",
      inputSchema: z.object({
        note: z.string().min(1).describe("The fact, as one short sentence."),
        section: z.string().optional().describe("Optional heading to file it under, e.g. 'About the person' or 'Projects'."),
      }),
      execute: async ({ note, section }) => {
        appendMemory(botId, note, section);
        publish({ type: "memory-changed", botId });
        return { saved: true };
      },
    }),
    memory_edit: createTool({
      id: "memory_edit",
      description:
        "Fix or remove a line in your MEMORY.md. `find` must match the current text exactly once; use an empty `replace` to delete it.",
      inputSchema: z.object({ find: z.string().min(1), replace: z.string() }),
      execute: async ({ find, replace }) => {
        const result = editMemory(botId, find, replace);
        if (result.ok) publish({ type: "memory-changed", botId });
        return result;
      },
    }),
  };
}

function projectMemoryTools(botId: string): ToolsInput {
  const requireProjectMemoryAccess = async () => {
    if (!(await canAccessProjectMemory(botId))) {
      throw new Error("This agent is not authorized to access shared project memory.");
    }
  };
  return {
    project_memory_read: createTool({
      id: "project_memory_read",
      description:
        "Read shared project memory. This tool is available only to agents explicitly authorized by the user. Agent-authored entries are marked unverified.",
      inputSchema: z.object({}),
      execute: async () => {
        await requireProjectMemoryAccess();
        return projectMemoryForAgent();
      },
    }),
    project_memory_add: createTool({
      id: "project_memory_add",
      description:
        "Add one durable note to shared project memory. Available only to explicitly authorized agents. Your entry is always attributed to you and marked unverified; never store secrets.",
      inputSchema: z.object({
        note: z.string().trim().min(1).max(4_000),
        section: z.string().trim().max(80).optional(),
      }),
      execute: async ({ note, section }) => {
        await requireProjectMemoryAccess();
        appendProjectMemoryEntry({
          note,
          section,
          source: { type: "agent", botId },
          confidence: "unverified",
        });
        publish({ type: "project-memory-changed" });
        return { saved: true, provenance: `agent ${botId}; unverified` };
      },
    }),
  };
}

function webTools(): ToolsInput {
  const apiKey = process.env.TAVILY_API_KEY;
  return {
    web_search: createTavilySearchTool({ apiKey }),
    read_page: createTavilyExtractTool({ apiKey }),
    crawl_site: createTavilyCrawlTool({ apiKey }),
  };
}

function collaborationTools(botId: string): ToolsInput {
  return {
    delegate_room_work: createTool({
      id: "delegate_room_work",
      description:
        "Delegate structured subtasks to room members. Each task must include its objective, context, expected output, assigned room-member bot ID, and dependencies. Independent tasks may run in parallel. For a verification task, set verificationOfTaskId and depend on the task being reviewed. Delegated bots keep their own approval permissions.",
      inputSchema: z.object({
        tasks: z.array(
          z.object({
            id: z.string().describe("Unique short ID within this delegation."),
            title: z.string(),
            objective: z.string(),
            context: z.string(),
            expectedOutput: z.string(),
            assignedBotId: z.string().describe("ID, not handle, of a room member."),
            dependencies: z.array(z.string()),
            verificationOfTaskId: z.string().optional(),
          }),
        ),
      }),
      execute: async (input, context) => {
        const threadId = context.agent?.threadId;
        if (!threadId) return { error: "Delegation requires an active room task." };
        const collaboration = await import("./collaboration");
        return collaboration.delegateRoomWork(botId, threadId, input, context.abortSignal);
      },
    }),
    room_collaborate: createTool({
      id: "room_collaborate",
      description:
        "Share research or exchange a question and answer with a room member. Use research to preserve findings; use question with a recipientBotId; answer must reference the question's messageId.",
      inputSchema: z.object({
        type: z.enum(["research", "question", "answer"]),
        content: z.string(),
        recipientBotId: z.string().optional(),
        responseToMessageId: z.string().optional(),
      }),
      execute: async (input, context) => {
        const threadId = context.agent?.threadId;
        if (!threadId) return { error: "Room messages require an active room task." };
        const collaboration = await import("./collaboration");
        return collaboration.sendRoomCollaborationMessage(botId, threadId, input, context.abortSignal);
      },
    }),
  };
}

export interface BotToolset {
  tools: ToolsInput;
  /** Extra prompt text the tools need (Code Mode's function stubs). */
  instructions: string[];
  /** What the bot can do, in words, for its own system prompt. */
  capabilities: string[];
}

export function buildTools(
  bot: Bot,
  connectorToolNames: ReadonlySet<string> = new Set(),
  sharedProjectMemoryAuthorized = false,
): BotToolset {
  const tools: ToolsInput = {};
  const instructions: string[] = [];
  const capabilities: string[] = [];
  Object.assign(tools, collaborationTools(bot.id));
  capabilities.push(
    "In group rooms, delegate bounded tasks to room members with delegate_room_work and share research or ask/answer teammates with room_collaborate. These tools are unavailable in direct-message contexts.",
  );
  // Do not expose shared project-memory tools to the model unless the user has
  // explicitly granted this exact bot access. The execute-time guard remains
  // in place as defence in depth.
  if (sharedProjectMemoryAuthorized) {
    Object.assign(tools, projectMemoryTools(bot.id));
    capabilities.push("You are explicitly authorized to use project_memory_read and project_memory_add for shared project notes. Your own MEMORY.md remains private; agent-added shared notes are marked unverified.");
  }

  if (bot.tools.webSearch && keys.tavily()) {
    Object.assign(tools, webTools());
    capabilities.push("Search the web (web_search), read pages (read_page) and crawl sites (crawl_site). Cite the URLs you used.");
  } else if (bot.tools.webSearch) {
    capabilities.push("Web search is switched on for you, but no Tavily key is set yet, so you can't search right now. Say so if asked.");
  }
  if (bot.tools.memory) {
    Object.assign(tools, memoryTools(bot.id));
  }
  const availableToolNames = new Set([...connectorToolNames, ...Object.keys(tools)]);
  if (bot.tools.codeMode) availableToolNames.add(CODE_MODE_TOOL);
  Object.assign(tools, reusableSkillTools(bot.skillIds ?? [], availableToolNames));
  capabilities.push(
    "Discover reusable skills with skill_discover and load assigned, compatible guidance with skill_load. Skills do not add tools, connections, credentials, or permissions.",
  );
  if (bot.tools.codeMode) {
    // The program runs in a QuickJS (WebAssembly) isolate with no filesystem or
    // network; its only reach is the tools passed here, bridged back to the host.
    const reachable = toolsAllowedInCodeMode(
      tools,
      bot.approval,
      bot.approvalPermissions ?? [],
      toolCategory,
    ) as ToolsInput;
    const codeMode = createCodeMode({ tools: reachable, timeout: 60_000 }, new QuickJsCodeModeTransport({ memoryLimitMb: 128 }));
    tools[CODE_MODE_TOOL] = codeMode.tool;
    instructions.push(codeMode.instructions);
    capabilities.push(
  `Run TypeScript with ${CODE_MODE_TOOL} when a question needs several tool calls, filtering, or exact arithmetic; call available tools from inside it with Promise.all. IMPORTANT: Never call COMPOSIO_* tools from inside ${CODE_MODE_TOOL}. For connected apps such as GitHub, call COMPOSIO_SEARCH_TOOLS directly, then call COMPOSIO_MULTI_EXECUTE_TOOL directly with the discovered action. These calls must be made directly by the agent so approval checks can work.`,
);
  }
  if (bot.tools.browser && keys.browserbase()) {
    capabilities.push(
      "Drive a real cloud browser with the browser_* tools for pages that need clicks, forms or JavaScript. Start with browser_goto, then browser_snapshot to get element refs. The person can watch you live. Prefer read_page for plain reading; it's faster.",
    );
  } else if (bot.tools.browser) {
    capabilities.push("The browser is switched on for you, but no Browserbase key is set yet, so browsing will fail. Say so if asked.");
  }
  return { tools, instructions, capabilities };
}

/** Which approval policy a tool falls under. Read and memory tools never ask;
 * acting in the browser does, unless the bot has Full access. */
export function toolCategory(toolName: string): ToolCategory | null {
  if (["skill_discover", "skill_load", "github_list_repositories"].includes(toolName)) return "read";
  if (["web_search", "read_page", "crawl_site", "ask_user", CODE_MODE_TOOL].includes(toolName)) return "read";
  if (toolName === "project_memory_read") return "read";
  if (toolName === "project_memory_add") return "edit";
  if (["delegate_room_work", "room_collaborate"].includes(toolName)) return "edit";
  // Composio: looking up actions is free; running them ("multi execute", the remote workbench) asks.
  if (toolName.startsWith("COMPOSIO_")) {
    return /SEARCH_TOOLS|GET_TOOL_SCHEMAS|MANAGE_CONNECTIONS/.test(toolName) ? "read" : "mcp";
  }
  // MCP tool names and descriptions are server-controlled, so never infer that
  // an MCP action is read-only from its name.
  if (toolName.startsWith("mcp_")) return "mcp";
  if (toolName.startsWith("memory_")) return "edit";
  if (toolName.startsWith("browser_")) {
    return /snapshot|screenshot|scroll|wait|tabs|close|get_|read|extract|console/.test(toolName) ? "read" : "execute";
  }
  return "other";
}

// ── how tool calls look in chat ─────────────────────────────────────────

function host(url: unknown): string {
  try {
    return new URL(String(url)).host.replace(/^www\./, "");
  } catch {
    return String(url ?? "");
  }
}

/** "SLACK_SEND_MESSAGE" → "Slack: send message" */
function composioAction(slug: string): string {
  const [app, ...rest] = String(slug).toLowerCase().split("_");
  return `${app.charAt(0).toUpperCase()}${app.slice(1)}: ${rest.join(" ")}`;
}

export function toolLabel(name: string, args: unknown): { label: string; detail?: string } {
  const a = (args ?? {}) as Record<string, unknown>;
  if (name.startsWith("COMPOSIO_")) {
    if (/SEARCH_TOOLS/.test(name)) {
      const queries = Array.isArray(a.queries) ? a.queries.map((q) => (q as { use_case?: string })?.use_case ?? q) : [];
      return { label: "Looked up app actions", detail: queries.map(String).join(", ") || undefined };
    }
    if (/MULTI_EXECUTE/.test(name)) {
      const runs = Array.isArray(a.tools) ? a.tools.map((t) => composioAction((t as { tool_slug?: string })?.tool_slug ?? "")) : [];
      return { label: "Used connected apps", detail: runs.join(", ") || undefined };
    }
    return { label: composioAction(name.replace(/^COMPOSIO_/, "")) };
  }
  if (name.startsWith("mcp_")) {
    const [, id, ...rest] = name.split("_");
    return { label: `${mcpServerNames.get(id) ?? "MCP"}: ${rest.join(" ")}` };
  }
  switch (name) {
    case "github_list_repositories":
      return { label: "Listed GitHub repositories" };
    case "web_search":
      return { label: "Searched the web", detail: String(a.query ?? "") };
    case "read_page": {
      const urls = Array.isArray(a.urls) ? a.urls : [a.urls ?? a.url];
      return { label: "Read", detail: urls.map(host).join(", ") };
    }
    case "crawl_site":
      return { label: "Crawled", detail: host(a.url) };
    case "memory_add":
      return { label: "Saved to memory", detail: String(a.note ?? "") };
    case "memory_edit":
      return { label: "Updated memory" };
    case "project_memory_read":
      return { label: "Read shared project memory" };
    case "project_memory_add":
      return { label: "Added to project memory", detail: String(a.note ?? "") };
    case CODE_MODE_TOOL:
      return { label: "Ran code" };
    case "ask_user":
      return { label: "Asked you" };
    case "delegate_room_work":
      return { label: "Delegated room tasks" };
    case "room_collaborate":
      return { label: "Shared with room" };
    default:
      if (name.startsWith("browser_")) {
        const action = name.slice("browser_".length).replace(/_/g, " ");
        return { label: `Browser: ${action}`, detail: a.url ? host(a.url) : undefined };
      }
      return { label: name.replace(/_/g, " ") };
  }
}

export function toolSources(result: unknown): Source[] | undefined {
  const r = result as { results?: Array<{ title?: string; url?: string }> } | null;
  if (!r || !Array.isArray(r.results)) return undefined;
  const sources = r.results
    .filter((x) => typeof x?.url === "string")
    .map((x) => ({ title: x.title || host(x.url), url: x.url as string }));
  return sources.length ? sources.slice(0, 8) : undefined;
}

export function toolPreview(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result.slice(0, 400);
  const r = result as Record<string, unknown>;
  if (typeof r.answer === "string" && r.answer) return r.answer.slice(0, 400);
  if (typeof r.error === "string") return r.error.slice(0, 400);
  if (typeof r.reason === "string") return r.reason.slice(0, 400);
  try {
    return JSON.stringify(result).slice(0, 400);
  } catch {
    return undefined;
  }
}
