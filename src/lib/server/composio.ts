// Connected apps through Composio: one key, OAuth handled by Composio, and
// hundreds of apps (Slack, GitHub, Gmail, Notion…). This install is one
// Composio "user"; every bot shares its connected accounts, and each bot only
// gets the apps you switch on for it.
import { randomUUID } from "node:crypto";
import { Composio } from "@composio/core";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { MastraProvider } from "@composio/mastra";
import type { ToolsInput } from "@mastra/core/agent";
import type { ComposioApp, ComposioDiscoveredTool, ComposioToolDiscovery } from "@/lib/shared/types";
import { getSetting, setSetting } from "./db";
import { InputError } from "./errors";

/** Shown first in the Connections panel; search finds the rest. */
export const FEATURED_APPS = ["slack", "github", "gmail", "googlecalendar", "notion", "linear", "googledrive", "jira"];
export const INTEGRATION_TARGETS = ["github", "gmail", "slack"] as const;

const g = globalThis as unknown as { __opencrewbotComposio?: { key: string; client: Composio<MastraProvider> } };

function client(): Composio<MastraProvider> | null {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) return null;
  if (g.__opencrewbotComposio?.key !== apiKey) {
    g.__opencrewbotComposio = { key: apiKey, client: new Composio({ apiKey, provider: new MastraProvider() }) };
  }
  return g.__opencrewbotComposio.client;
}

/** A stable id for this install, created once and kept in settings. */
async function userId(): Promise<string> {
  const existing = await getSetting<string>("composio.userId");
  if (existing) return existing;
  const id = `opencrewbot-${randomUUID()}`;
  await setSetting("composio.userId", id);
  return id;
}

function requireClient(): Composio<MastraProvider> {
  const c = client();
  if (!c) throw new Error("Set COMPOSIO_API_KEY in .env and restart the app to connect apps.");
  return c;
}

/** Apps with their connection state. With a search term, searches Composio's whole catalog. */
export async function listApps(search?: string): Promise<ComposioApp[]> {
  const c = requireClient();
  const session = await c.create(await userId(), { manageConnections: false });
  const result = await session.toolkits(search ? { search, limit: 20 } : { toolkits: FEATURED_APPS, limit: FEATURED_APPS.length });
  const apps = result.items.map((t) => ({
    slug: t.slug,
    name: t.name,
    logo: t.logo,
    connected: Boolean(t.connection?.isActive),
  }));
  if (search) return apps;
  // Keep the featured order, then anything else already connected.
  const connected = await c.connectedAccounts.list({ userIds: [await userId()], statuses: ["ACTIVE"] });
  const extra = connected.items.map((a) => a.toolkit.slug).filter((slug) => !FEATURED_APPS.includes(slug));
  const extraApps = extra.length
    ? (await session.toolkits({ toolkits: [...new Set(extra)], limit: extra.length })).items.map((t) => ({
        slug: t.slug,
        name: t.name,
        logo: t.logo,
        connected: true,
      }))
    : [];
  return [...apps.sort((a, b) => FEATURED_APPS.indexOf(a.slug) - FEATURED_APPS.indexOf(b.slug)), ...extraApps];
}

/** Start the sign-in flow for an app. Composio sends the person back to `callbackUrl`. */
export async function connectApp(slug: string, callbackUrl: string): Promise<string> {
  const c = requireClient();
  const session = await c.create(await userId(), { manageConnections: false });
  const request = await session.authorize(slug, { callbackUrl });
  if (!request.redirectUrl) throw new Error(`Composio didn't return a sign-in link for ${slug}.`);
  return request.redirectUrl;
}

/** Remove every connected account this install has for an app. */
export async function disconnectApp(slug: string): Promise<void> {
  const c = requireClient();
  const accounts = await c.connectedAccounts.list({ userIds: [await userId()], toolkitSlugs: [slug] });
  for (const account of accounts.items) await c.connectedAccounts.delete(account.id);
}

type GithubSchema = {
  toolSlug?: unknown;
  toolkit?: unknown;
  inputParameters?: unknown;
  input_parameters?: unknown;
  inputSchema?: unknown;
  input_schema?: unknown;
  parameters?: unknown;
};

type GithubDiscovery = {
  success?: boolean;
  error?: string | null;
  toolkitConnectionStatuses?: Array<{ toolkit: string; hasActiveConnection: boolean }>;
  toolSchemas?: Record<string, GithubSchema>;
};

type GithubExecution = {
  resultType?: string;
  error?: string | null;
  data?: unknown;
};

const githubActionCache = globalThis as typeof globalThis & {
  __opencrewbotGithubListAction?: { key: string; slug: string; schema: Record<string, unknown>; at: number };
};

function githubParameterMap(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) {
    const entries = raw.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const name = record.name ?? record.key ?? record.parameterName ?? record.parameter_name;
      return typeof name === "string" ? [[name, record] as const] : [];
    });
    return Object.fromEntries(entries);
  }
  if (!raw || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;
  for (const key of ["properties", "parameters", "fields"]) {
    if (record[key] && typeof record[key] === "object") return githubParameterMap(record[key]);
  }
  return record;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function extractRepositories(value: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 6) return [];
  const parsed = parseJsonValue(value);
  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
  }
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  for (const key of ["repositories", "repos", "items", "data", "results", "response_data", "response"] ) {
    if (record[key] !== undefined) {
      const found = extractRepositories(record[key], depth + 1);
      if (found.length || Array.isArray(parseJsonValue(record[key]))) return found;
    }
  }
  return [];
}

function findNumericTotal(value: unknown, depth = 0): number | undefined {
  if (depth > 6) return undefined;
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  for (const key of ["total_count", "totalCount", "total"]) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  for (const key of ["data", "response_data", "response", "pagination", "meta", "page_info"]) {
    const nested = findNumericTotal(record[key], depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function findPageInfo(value: unknown, depth = 0): { hasMore?: boolean; nextCursor?: string } {
  if (depth > 6) return {};
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  for (const key of ["has_more", "hasMore", "has_next_page", "hasNextPage", "has_next", "hasNext"]) {
    if (typeof record[key] === "boolean") return { hasMore: record[key] };
  }
  for (const key of ["next_cursor", "nextCursor", "next_page_token", "nextPageToken", "cursor_next"]) {
    if (typeof record[key] === "string" && record[key]) return { hasMore: true, nextCursor: record[key] as string };
  }
  for (const key of ["pagination", "page_info", "meta", "data", "response_data", "response"]) {
    const nested = findPageInfo(record[key], depth + 1);
    if (nested.hasMore !== undefined || nested.nextCursor) return nested;
  }
  return {};
}

/** Execute GitHub listing directly through the authenticated Composio session. */
async function githubRepositoriesFromSession(
  search: () => Promise<unknown>,
  execute: (slug: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<string> {
  const cacheKey = process.env.COMPOSIO_API_KEY ?? "";
  let action = githubActionCache.__opencrewbotGithubListAction;
  if (!action || action.key !== cacheKey || Date.now() - action.at > 30 * 60 * 1000) {
    const discovery = (await search()) as GithubDiscovery;
    if (!discovery.success) throw new Error(discovery.error || "GitHub action discovery failed. Reconnect GitHub and retry.");
    const connection = discovery.toolkitConnectionStatuses?.find((item) => item.toolkit.toLowerCase() === "github");
    if (!connection?.hasActiveConnection) throw new Error("GitHub is not connected. Reconnect it in OpenCrewBot Settings.");
    const candidates = Object.values(discovery.toolSchemas ?? {}).filter((item) =>
      typeof item.toolSlug === "string" && typeof item.toolkit === "string" &&
      item.toolkit.toLowerCase() === "github" &&
      /(?:LIST|GET).*REPOSITOR(?:Y|IES)|REPOSITOR(?:Y|IES).*(?:LIST|GET)/i.test(item.toolSlug),
    );
    candidates.sort((a, b) => {
      const score = (slug: unknown) => {
        const value = String(slug).toUpperCase();
        return (value.includes("LIST_REPOSITORIES") ? 4 : 0) + (value.includes("AUTHENTICATED") ? 3 : 0) +
          (value.includes("USER") ? 2 : 0) + (value.includes("REPO") ? 1 : 0);
      };
      return score(b.toolSlug) - score(a.toolSlug);
    });
    const candidate = candidates[0];
    if (!candidate || typeof candidate.toolSlug !== "string") {
      throw new Error("Composio did not expose a GitHub list-repositories action.");
    }
    const rawSchema = candidate.inputSchema ?? candidate.input_schema ?? candidate.inputParameters ?? candidate.input_parameters ?? candidate.parameters;
    action = { key: cacheKey, slug: candidate.toolSlug, schema: githubParameterMap(rawSchema), at: Date.now() };
    githubActionCache.__opencrewbotGithubListAction = action;
  }

  const schemaKeys = new Set(Object.keys(action.schema));
  const findKey = (names: string[]) => names.find((name) => schemaKeys.has(name));
  const pageKey = findKey(["page", "page_number", "pageNumber"]);
  const cursorKey = findKey(["cursor", "page_token", "pageToken", "after", "next_cursor", "nextCursor"]);
  const pageSizeKey = findKey(["per_page", "perPage", "limit", "page_size", "pageSize"]);
  const pageSize = pageSizeKey ? 100 : 30;
  const canPaginate = Boolean(pageKey || cursorKey);
  const all: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let reportedTotal: number | undefined;
  let complete = false;
  let cursor: string | undefined;
  let pagesFetched = 0;

  for (let page = 1; page <= 50; page++) {
    const args: Record<string, unknown> = {};
    if (pageSizeKey) args[pageSizeKey] = 100;
    if (pageKey) args[pageKey] = page;
    if (cursorKey && cursor) args[cursorKey] = cursor;
    const affiliationKey = findKey(["affiliation"]);
    const typeKey = findKey(["type"]);
    const sortKey = findKey(["sort"]);
    const directionKey = findKey(["direction"]);
    const visibilityKey = findKey(["visibility"]);
    if (affiliationKey) args[affiliationKey] = "owner";
    if (typeKey) args[typeKey] = "owner";
    if (sortKey) args[sortKey] = "updated";
    if (directionKey) args[directionKey] = "desc";
    if (visibilityKey) args[visibilityKey] = "all";

    const execution = (await execute(action.slug, args)) as GithubExecution;
    if (execution.resultType !== "completed") {
      throw new Error(execution.error || `GitHub listing failed (${execution.resultType ?? "unknown result"}).`);
    }
    const data = execution.data;
    pagesFetched++;
    reportedTotal = findNumericTotal(data) ?? reportedTotal;
    const repositories = extractRepositories(data);
    let addedThisPage = 0;
    for (const repository of repositories) {
      const fullName = typeof repository.full_name === "string" ? repository.full_name :
        typeof repository.fullName === "string" ? repository.fullName :
        typeof repository.name === "string" ? repository.name : "";
      if (!fullName || seen.has(fullName.toLowerCase())) continue;
      seen.add(fullName.toLowerCase());
      all.push(repository);
      addedThisPage++;
    }

    const pageInfo = findPageInfo(data);
    if (reportedTotal !== undefined && all.length >= reportedTotal) {
      complete = true;
      break;
    }
    if (pageInfo.hasMore === false) {
      complete = true;
      break;
    }
    if (pageInfo.nextCursor && cursorKey) {
      cursor = pageInfo.nextCursor;
      continue;
    }
    if (pageInfo.hasMore === true) {
      if (pageKey && addedThisPage > 0) continue;
      complete = false;
      break;
    }
    if (repositories.length === 0) {
      complete = reportedTotal === 0 || pageInfo.hasMore === false;
      break;
    }
    if (repositories.length < pageSize) {
      complete = true;
      break;
    }
    if (!canPaginate || addedThisPage === 0) {
      complete = false;
      break;
    }
    if (page === 50) complete = false;
  }

  all.sort((a, b) => String(b.updated_at ?? b.updatedAt ?? "").localeCompare(String(a.updated_at ?? a.updatedAt ?? "")));
  const lines = all.map((repository) => {
    const name = String(repository.full_name ?? repository.fullName ?? repository.name ?? "Unknown");
    const description = typeof repository.description === "string" && repository.description.trim()
      ? repository.description.trim().replace(/\s+/g, " ")
      : "—";
    return `| ${name.replace(/\|/g, "\\|")} | ${description.replace(/\|/g, "\\|")} |`;
  });
  const total = complete ? all.length : (reportedTotal ?? all.length);
  return [
    "GITHUB_REPOSITORIES_RESULT",
    `Returned: ${all.length}; total reported by GitHub: ${reportedTotal ?? "not provided"}; pages fetched: ${pagesFetched}; complete: ${complete ? "yes" : "not verified"}.`,
    "| Repository | Description |",
    "|---|---|",
    ...lines,
    complete ? `Total repositories: ${total}.` : `WARNING: Only ${all.length} repositories were fetched. The total is not verified; the connected action did not expose enough pagination metadata to prove completeness.`,
  ].join("\n");
}

/** Used for a fast-path repository request: no LLM call or agent tool loop. */
export async function listGitHubRepositoriesDirect(): Promise<string> {
  const c = requireClient();
  const session = await c.create(await userId(), { toolkits: ["github"], manageConnections: false });
  return githubRepositoriesFromSession(
    () => session.search({ query: "GitHub list repositories owned by the authenticated user including private repositories with pagination per_page page", toolkits: ["github"] }),
    (slug, args) => session.execute(slug, args),
  );
}

/** Tools for the given apps, as one Composio session. */
export async function composioTools(slugs: string[]): Promise<ToolsInput> {
  const c = client();
  if (!c || slugs.length === 0) return {};
  const session = await c.create(await userId(), { toolkits: slugs, manageConnections: false });
  const tools = (await session.tools()) as unknown as ToolsInput;

  if (slugs.includes("github")) {
    tools.github_list_repositories = createTool({
      id: "github_list_repositories",
      description:
        "FAST deterministic GitHub repository listing. Lists repositories owned by the connected authenticated account, including private repositories. Returns a compact ready-to-display Markdown table and exact count. Do not analyse repository descriptions, filter results, or call other tools after this tool; simply show its result.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        type Schema = {
          toolSlug?: unknown;
          toolkit?: unknown;
          inputParameters?: unknown;
          input_parameters?: unknown;
          inputSchema?: unknown;
          input_schema?: unknown;
          parameters?: unknown;
        };
        const cache = globalThis as typeof globalThis & {
          __opencrewbotGithubListAction?: { key: string; slug: string; schema: Record<string, unknown>; at: number };
        };
        const cacheKey = process.env.COMPOSIO_API_KEY ?? "";
        let action = cache.__opencrewbotGithubListAction;
        if (!action || action.key !== cacheKey || Date.now() - action.at > 30 * 60 * 1000) {
          const discovery = await session.search({
            query: "GitHub list repositories owned by authenticated user including private repositories with pagination per_page page",
            toolkits: ["github"],
          });
          if (!discovery.success) throw new Error("GitHub action discovery failed. Reconnect GitHub and retry.");
          const connection = discovery.toolkitConnectionStatuses?.find((item) => item.toolkit.toLowerCase() === "github");
          if (!connection?.hasActiveConnection) throw new Error("GitHub is not connected. Reconnect it in OpenCrewBot Settings.");
          const schemas = Object.values(discovery.toolSchemas ?? {}) as Schema[];
          const candidate = schemas.find((item) =>
            typeof item.toolSlug === "string" && typeof item.toolkit === "string" &&
            item.toolkit.toLowerCase() === "github" &&
            /(?:LIST|GET).*REPOSITOR(?:Y|IES)|REPOSITOR(?:Y|IES).*(?:LIST|GET)/i.test(item.toolSlug),
          );
          if (!candidate || typeof candidate.toolSlug !== "string") {
            throw new Error("Composio did not expose a GitHub list-repositories action.");
          }
          const rawSchema = candidate.inputParameters ?? candidate.input_parameters ?? candidate.inputSchema ?? candidate.input_schema ?? candidate.parameters;
          const properties = rawSchema && typeof rawSchema === "object"
            ? ((rawSchema as Record<string, unknown>).properties as Record<string, unknown> | undefined) ?? rawSchema as Record<string, unknown>
            : {};
          action = { key: cacheKey, slug: candidate.toolSlug, schema: properties, at: Date.now() };
          cache.__opencrewbotGithubListAction = action;
        }

        const schemaKeys = new Set(Object.keys(action.schema));
        const argsForPage = (page: number) => {
          const args: Record<string, unknown> = {};
          const set = (names: string[], value: unknown) => {
            const key = names.find((name) => schemaKeys.has(name));
            if (key) args[key] = value;
          };
          set(["per_page", "perPage", "limit"], 100);
          set(["page", "page_number", "pageNumber"], page);
          set(["affiliation"], "owner");
          set(["type"], "owner");
          set(["sort"], "updated");
          set(["direction"], "desc");
          set(["visibility"], "all");
          return args;
        };
        const extractRepos = (value: unknown): Array<Record<string, unknown>> => {
          if (typeof value === "string") {
            try { return extractRepos(JSON.parse(value)); } catch { return []; }
          }
          if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
          if (!value || typeof value !== "object") return [];
          const obj = value as Record<string, unknown>;
          for (const key of ["repositories", "repos", "items", "data", "results"]) {
            const found = obj[key];
            if (Array.isArray(found)) return found.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
            if (found && typeof found === "object") {
              const nested = extractRepos(found);
              if (nested.length) return nested;
            }
          }
          return [];
        };
        const all: Array<Record<string, unknown>> = [];
        const seen = new Set<string>();
        let reportedTotal: number | undefined;
        let pagesFetched = 0;
        const paginationSupported = ["page", "page_number", "pageNumber"].some((key) => schemaKeys.has(key));
        const pageSize = ["per_page", "perPage", "limit"].some((key) => schemaKeys.has(key)) ? 100 : 30;
        for (let page = 1; page <= (paginationSupported ? 50 : 1); page++) {
          const execution = await session.execute(action.slug, argsForPage(page));
          if (execution.resultType !== "completed") throw new Error(execution.error || `GitHub listing failed (${execution.resultType}).`);
          const data = execution.data as unknown;
          pagesFetched++;
          if (data && typeof data === "object" && !Array.isArray(data)) {
            const obj = data as Record<string, unknown>;
            const total = obj.total_count ?? obj.totalCount ?? obj.count;
            if (typeof total === "number" && Number.isFinite(total)) reportedTotal = total;
          }
          const repos = extractRepos(data);
          for (const repo of repos) {
            const fullName = typeof repo.full_name === "string" ? repo.full_name :
              typeof repo.fullName === "string" ? repo.fullName :
              typeof repo.name === "string" ? repo.name : "";
            if (!fullName || seen.has(fullName.toLowerCase())) continue;
            seen.add(fullName.toLowerCase());
            all.push(repo);
          }
          if (!paginationSupported || repos.length < pageSize || (reportedTotal !== undefined && all.length >= reportedTotal)) break;
        }
        all.sort((a, b) => String(b.updated_at ?? b.updatedAt ?? "").localeCompare(String(a.updated_at ?? a.updatedAt ?? "")));
        const complete = reportedTotal !== undefined ? all.length >= reportedTotal : (!paginationSupported || all.length < pageSize);
        const lines = all.map((repo) => {
          const name = String(repo.full_name ?? repo.fullName ?? repo.name ?? "Unknown");
          const description = typeof repo.description === "string" && repo.description.trim() ? repo.description.trim().replace(/\s+/g, " ") : "—";
          return `| ${name.replace(/\|/g, "\\|")} | ${description.replace(/\|/g, "\\|")} |`;
        });
        const total = reportedTotal ?? all.length;
        return [
          `GITHUB_REPOSITORIES_RESULT`,
          `Total returned: ${all.length}; reported total: ${reportedTotal ?? "not provided"}; pages fetched: ${pagesFetched}; complete: ${complete ? "yes" : "not verified"}.`,
          `| Repository | Description |`, `|---|---|`, ...lines,
          complete ? `Total repositories: ${total}.` : `WARNING: Result may be incomplete. Do not claim all repositories were fetched; fetched ${all.length}.`,
        ].join("\n");
      },
    });
  }
  return tools;
}

export function publicDiscoveredTools(
  schemas: Record<string, { toolSlug?: unknown; toolkit?: unknown; description?: unknown }>,
  expectedToolkit: string,
): ComposioDiscoveredTool[] {
  const tools = new Map<string, ComposioDiscoveredTool>();
  for (const schema of Object.values(schemas)) {
    if (
      typeof schema.toolSlug !== "string" ||
      !/^[A-Z0-9_]{1,120}$/i.test(schema.toolSlug) ||
      typeof schema.toolkit !== "string" ||
      schema.toolkit.toLowerCase() !== expectedToolkit
    ) {
      continue;
    }
    tools.set(schema.toolSlug, {
      toolSlug: schema.toolSlug,
      toolkit: expectedToolkit,
      description: typeof schema.description === "string" ? schema.description.slice(0, 500) : "",
    });
  }
  return [...tools.values()].slice(0, 20);
}

export function formatToolDiscoveryResult(
  slug: string,
  result: {
    success: boolean;
    toolkitConnectionStatuses: { toolkit: string; hasActiveConnection: boolean }[];
    toolSchemas: Record<string, { toolSlug?: unknown; toolkit?: unknown; description?: unknown }>;
  },
): ComposioToolDiscovery {
  if (!result.success) {
    return {
      slug,
      status: "error",
      message: "Composio could not complete tool discovery. Check the Composio connection and try again.",
      tools: [],
    };
  }
  const connected = result.toolkitConnectionStatuses.some(
    (status) => status.toolkit.toLowerCase() === slug && status.hasActiveConnection,
  );
  return {
    slug,
    status: connected ? "connected" : "disconnected",
    message: connected
      ? undefined
      : "Tools can be discovered, but this app is not connected and cannot be used by bots yet.",
    tools: publicDiscoveredTools(result.toolSchemas, slug),
  };
}

export async function discoverAppTools(slug: string, query: string): Promise<ComposioToolDiscovery> {
  if (!INTEGRATION_TARGETS.includes(slug as (typeof INTEGRATION_TARGETS)[number])) {
    throw new InputError("Choose GitHub, Gmail, or Slack for tool discovery.");
  }
  const normalizedQuery = query.trim();
  if (normalizedQuery.length < 2 || normalizedQuery.length > 200) {
    throw new InputError("Describe the action to find in 2 to 200 characters.");
  }
  const c = client();
  if (!c) {
    return {
      slug,
      status: "unavailable",
      message: "Composio is not configured. Add COMPOSIO_API_KEY to enable live integrations.",
      tools: [],
    };
  }

  try {
    const session = await c.create(await userId(), { toolkits: [slug], manageConnections: false });
    const result = await session.search({ query: normalizedQuery, toolkits: [slug] });
    return formatToolDiscoveryResult(slug, result);
  } catch (error) {
    console.error(`[opencrewbot] Composio tool discovery failed for ${slug}.`, error);
    return {
      slug,
      status: "error",
      message: "Composio tool discovery failed. Check the service configuration and try again.",
      tools: [],
    };
  }
}
