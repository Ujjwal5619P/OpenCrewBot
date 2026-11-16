// The tools a bot gets, from its settings. Names are short snake_case words
// because open models pick tools by name more reliably that way.
import type { ToolsInput } from "@mastra/core/agent";
import { createTool, createCodeMode } from "@mastra/core/tools";
import type { ToolCategory } from "@mastra/core/agent-controller";
import { createTavilyCrawlTool, createTavilyExtractTool, createTavilySearchTool } from "@mastra/tavily";
import { QuickJsCodeModeTransport } from "@mastra/quickjs";
import { z } from "zod";
import type { Bot, Source } from "@/lib/shared/types";
import { appendMemory, appendRoomMemory, editMemory, editRoomMemory } from "./memory-files";
import { publish } from "./bus";
import { keys } from "./config";
import { mcpServerNames } from "./connectors";
import { analyzeCsvFile } from "./csv";
import { DelegationToolInputSchema } from "./delegation";
import { InputError } from "./errors";
import { SKILL_IDS, listSkills, runSkill } from "./skills";

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
    room_memory_add: createTool({
      id: "room_memory_add",
      description:
        "Save a shared decision or fact to the current group room's shared MEMORY.md so all room members can see it. Only works inside a group room.",
      inputSchema: z.object({
        note: z.string().min(1).describe("The shared decision or fact, as one concise sentence."),
        section: z.string().optional().describe("Optional section heading, e.g. 'Decisions' or 'Target Audience'."),
      }),
      execute: async ({ note, section }, ctx) => {
        const conversationId = ctx?.requestContext?.get("conversationId");
        if (typeof conversationId !== "string" || !conversationId.startsWith("room:")) {
          throw new InputError("room_memory_add only works inside a group room; use memory_add for your personal MEMORY.md.");
        }
        const roomId = conversationId.slice("room:".length);
        appendRoomMemory(roomId, note, section);
        publish({ type: "room-memory-changed", roomId });
        return { saved: true, roomId };
      },
    }),
    room_memory_edit: createTool({
      id: "room_memory_edit",
      description:
        "Fix or remove a line in the current group room's shared MEMORY.md. `find` must match the exact text once; empty `replace` deletes it.",
      inputSchema: z.object({ find: z.string().min(1), replace: z.string() }),
      execute: async ({ find, replace }, ctx) => {
        const conversationId = ctx?.requestContext?.get("conversationId");
        if (typeof conversationId !== "string" || !conversationId.startsWith("room:")) {
          throw new InputError("room_memory_edit only works inside a group room.");
        }
        const roomId = conversationId.slice("room:".length);
        const result = editRoomMemory(roomId, find, replace);
        if (result.ok) publish({ type: "room-memory-changed", roomId });
        return result;
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

export interface BotToolset {
  tools: ToolsInput;
  /** Extra prompt text the tools need (Code Mode's function stubs). */
  instructions: string[];
  /** What the bot can do, in words, for its own system prompt. */
  capabilities: string[];
}

export function buildTools(bot: Bot): BotToolset {
  const tools: ToolsInput = {};
  const instructions: string[] = [];
  const capabilities: string[] = [];

  if (bot.tools.webSearch && keys.tavily()) {
    Object.assign(tools, webTools());
    capabilities.push("Search the web (web_search), read pages (read_page) and crawl sites (crawl_site). Cite the URLs you used.");
  } else if (bot.tools.webSearch) {
    capabilities.push("Web search is enabled, but Tavily is not configured (TAVILY_API_KEY is not set), so live web search is unavailable.");
  }
  if (bot.tools.memory) {
    Object.assign(tools, memoryTools(bot.id));
  }
  tools.delegate_tasks = createTool({
    id: "delegate_tasks",
    description:
      "Delegate 1-20 structured tasks to valid members of the current group room (supports parallel waves and dependsOn). Always include a non-empty `tasks` array; `id` is auto-generated if omitted.",
    inputSchema: DelegationToolInputSchema,
    execute: async (input, ctx) => {
      const conversationId = ctx?.requestContext?.get("conversationId");
      if (typeof conversationId !== "string" || !conversationId.startsWith("room:")) {
        throw new InputError("delegate_tasks can only be used inside a group room.");
      }
      const roomId = conversationId.slice("room:".length);
      const { delegateInRoom } = await import("./rooms");
      const report = await delegateInRoom(roomId, bot, input);
      if (!report.ok && report.summary.done === 0) {
        throw new InputError(report.errorSummary || "Delegation failed: no tasks completed.");
      }
      return report;
    },
  });
  tools.list_skills = createTool({
    id: "list_skills",
    description: "List the 8 reusable business and engineering skills available in this workspace.",
    inputSchema: z.object({}),
    execute: async () => ({ skills: listSkills() }),
  });
  tools.run_skill = createTool({
    id: "run_skill",
    description: `Execute one of the 8 reusable skills (${SKILL_IDS.join(", ")}) with structured input. Requires \`skillId\`; never use run_skill for GitHub operations.`,
    inputSchema: z
      .object({
        skillId: z.enum(SKILL_IDS).describe(`Required skill ID. Must be one of: ${SKILL_IDS.join(", ")}`),
        input: z.record(z.string(), z.unknown()).optional().describe("Structured parameters for the skill."),
      })
      .strict(),
    execute: async ({ skillId, input }) => await runSkill(skillId, input),
  });
  if (bot.tools.codeMode) {
    tools.read_csv = createTool({
      id: "read_csv",
      description:
        "Read and dynamically analyze a workspace CSV file (under samples/ or data/, e.g. samples/meetuniversity_campaigns.csv or uploaded data/uploads/*.csv) for revenue, cost, profit, margins, and monthly trends.",
      inputSchema: z.object({
        path: z.string().trim().default("samples/meetuniversity_campaigns.csv").describe("Relative path under samples/ or data/."),
      }),
      execute: async ({ path }) => analyzeCsvFile(path),
    });
    // The program runs in a QuickJS (WebAssembly) isolate with no filesystem or
    // network; its only reach is the tools passed here, bridged back to the host.
    const reachable = { ...tools };
    const codeMode = createCodeMode({ tools: reachable, timeout: 60_000 }, new QuickJsCodeModeTransport({ memoryLimitMb: 128 }));
    tools[CODE_MODE_TOOL] = codeMode.tool;
    instructions.push(codeMode.instructions);
    capabilities.push(
      `Read workspace CSV spreadsheets with read_csv and run TypeScript with ${CODE_MODE_TOOL} for filtering or exact arithmetic; call the other tools from inside it with Promise.all.`,
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
/** MCP tool names that only look things up. A heuristic over the tool's own name:
 * anything that doesn't read clearly as a lookup asks first. */
const READ_ONLY_VERB = /^(get|list|search|read|fetch|find|view|show|describe|lookup|query)(_|$)/;

export function toolCategory(toolName: string): ToolCategory | null {
  if (["web_search", "read_page", "crawl_site", "ask_user", "read_csv", "list_skills", "run_skill", "github_repos_list", CODE_MODE_TOOL].includes(toolName)) return "read";
  // Composio: looking up actions is free; running them ("multi execute", the remote workbench) asks.
  if (toolName.startsWith("COMPOSIO_")) {
    return /SEARCH_TOOLS|GET_TOOL_SCHEMAS|MANAGE_CONNECTIONS/.test(toolName) ? "read" : "mcp";
  }
  if (toolName.startsWith("mcp_")) {
    const action = toolName.split("_").slice(2).join("_");
    return READ_ONLY_VERB.test(action) ? "read" : "mcp";
  }
  if (toolName.startsWith("memory_") || toolName.startsWith("room_memory_")) return "edit";
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
    case "room_memory_add":
      return { label: "Saved to room memory", detail: String(a.note ?? "") };
    case "room_memory_edit":
      return { label: "Updated room memory" };
    case CODE_MODE_TOOL:
      return { label: "Ran code" };
    case "ask_user":
      return { label: "Asked you" };
    case "delegate_tasks": {
      const count = Array.isArray(a.tasks) ? a.tasks.length : 0;
      return { label: "Delegated tasks", detail: count ? `${count} ${count === 1 ? "task" : "tasks"}` : undefined };
    }
    case "read_csv":
      return { label: "Analyzed CSV", detail: String(a.path ?? "samples/meetuniversity_campaigns.csv") };
    case "list_skills":
      return { label: "Listed skills" };
    case "run_skill":
      return { label: "Ran skill", detail: String(a.skillId ?? "") };
    case "github_repos_list":
      return { label: "Listed GitHub repositories", detail: a.visibility ? `${String(a.visibility)} · page ${String(a.page ?? 1)}` : undefined };
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
  if (typeof r.errorSummary === "string" && r.errorSummary) return r.errorSummary.slice(0, 400);
  if (typeof r.answer === "string" && r.answer) return r.answer.slice(0, 400);
  if (typeof r.error === "string") return r.error.slice(0, 400);
  if (typeof r.reason === "string") return r.reason.slice(0, 400);
  try {
    return JSON.stringify(result).slice(0, 400);
  } catch {
    return undefined;
  }
}
