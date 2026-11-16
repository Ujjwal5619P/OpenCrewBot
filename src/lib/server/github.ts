import { z } from "zod";
import type { Bot, GithubConnectionStatus, GithubRepoSummary } from "@/lib/shared/types";
import { executeComposioTool, hasActiveAppConnection } from "./composio";
import { keys } from "./config";
import { InputError } from "./errors";
import { listStoredServers, type StoredServer } from "./mcp-servers";

const MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 10_000;

export const GithubReposListInputSchema = z
  .object({
    visibility: z.enum(["all", "public", "private"]).describe("Required filter: 'all', 'public', or 'private'."),
    perPage: z.number().int().min(1).max(100).describe("Required repositories per page (1-100), e.g. 30."),
    page: z.number().int().min(1).max(100).describe("Required 1-based page index, e.g. 1."),
    allPages: z.boolean().optional().describe("When true, follows pagination to retrieve all accessible repositories."),
    sort: z.enum(["created", "updated", "pushed", "full_name"]).optional().describe("Sort field (default: updated)."),
  })
  .strict();

export type GithubReposListInput = z.infer<typeof GithubReposListInputSchema>;

export interface GithubReposListResult {
  source: "mcp" | "composio" | "env";
  totalCount: number;
  page: number;
  perPage: number;
  allPages: boolean;
  pagesFetched: number;
  hasNextPage: boolean;
  nextPage: number | null;
  repositories: GithubRepoSummary[];
}

export function githubApiBaseUrl(): string {
  return (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
}

function envGithubToken(): string | undefined {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  return token?.trim() || undefined;
}

export function isGithubMcpServer(server: Pick<StoredServer, "name" | "url">): boolean {
  if (server.name.toLowerCase().includes("github")) return true;
  try {
    return new URL(server.url).hostname.toLowerCase().includes("github");
  } catch {
    return false;
  }
}

export function botHasGithubPermission(bot: Bot, storedServers: StoredServer[]): boolean {
  const githubMcpIds = new Set(storedServers.filter(isGithubMcpServer).map((s) => s.id));
  return bot.connections.some((conn) => {
    if (conn === "github:env" || conn === "github" || conn === "composio:github") return true;
    if (conn.startsWith("mcp:")) {
      return githubMcpIds.has(conn.slice("mcp:".length));
    }
    return false;
  });
}

export function parseGithubReposListInput(rawInput: unknown): GithubReposListInput {
  const parsed = GithubReposListInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "input"}: ${i.message}`).join("; ");
    throw new InputError(
      `Invalid arguments for github_repos_list (${issues}). Provide required fields: { visibility: "all" | "public" | "private", perPage: number (1-100), page: number (>=1) }.`,
    );
  }
  return parsed.data;
}

function parseNextPageFromLinkHeader(linkHeader: string | null): number | null {
  if (!linkHeader) return null;
  for (const segment of linkHeader.split(",")) {
    if (!/;\s*rel=["']?next["']?/i.test(segment)) continue;
    const match = segment.match(/<([^>]+)>/);
    if (!match) continue;
    try {
      const url = new URL(match[1]);
      const p = Number(url.searchParams.get("page"));
      if (Number.isInteger(p) && p > 0) return p;
    } catch {
      // ignore malformed URL
    }
  }
  return null;
}

function normalizeRepo(raw: unknown): GithubRepoSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || typeof r.full_name !== "string" || typeof r.html_url !== "string") return null;
  const isPrivate = Boolean(r.private);
  return {
    name: r.name,
    full_name: r.full_name,
    description: typeof r.description === "string" && r.description.trim() ? r.description : null,
    private: isPrivate,
    visibility: isPrivate ? "private" : "public",
    default_branch: typeof r.default_branch === "string" && r.default_branch ? r.default_branch : "main",
    html_url: r.html_url,
  };
}

function extractRepoArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  if (Array.isArray(obj.data)) return obj.data;
  if (obj.data && typeof obj.data === "object") {
    const nested = obj.data as Record<string, unknown>;
    if (Array.isArray(nested.details)) return nested.details;
    if (Array.isArray(nested.repositories)) return nested.repositories;
    if (Array.isArray(nested.items)) return nested.items;
  }
  if (Array.isArray(obj.repositories)) return obj.repositories;
  return [];
}

async function fetchGithubJson<T>(pathAndQuery: string, token: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ data: T; headers: Headers }> {
  const url = `${githubApiBaseUrl()}${pathAndQuery}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "OpenCrewBot",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new InputError(`GitHub API request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw new InputError(`Failed to reach GitHub API: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (res.status === 401) {
    throw new InputError("GitHub authentication failed (401 Unauthorized). Check that your GitHub token or OAuth connection is valid and not expired.");
  }
  if (res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      throw new InputError("GitHub API rate limit exceeded (403). Please wait before retrying.");
    }
    throw new InputError("GitHub permission denied (403 Forbidden). Ensure your token includes 'repo' (or 'public_repo') scope.");
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const errBody = (await res.json()) as { message?: string };
      if (errBody?.message) msg = `${msg}: ${errBody.message}`;
    } catch {
      // ignore non-json error body
    }
    throw new InputError(`GitHub API request failed (${msg}).`);
  }

  return { data: (await res.json()) as T, headers: res.headers };
}

type ResolvedAuth =
  | { source: "mcp" | "env"; token: string }
  | { source: "composio" };

async function resolveGithubAuth(bot: Bot | null, storedServers: StoredServer[]): Promise<ResolvedAuth> {
  const githubServers = storedServers.filter(isGithubMcpServer);
  const envToken = envGithubToken();

  if (bot) {
    for (const conn of bot.connections) {
      if (conn.startsWith("mcp:")) {
        const srv = githubServers.find((s) => s.id === conn.slice("mcp:".length));
        if (srv?.token) return { source: "mcp", token: srv.token };
      }
    }
    if (bot.connections.includes("composio:github") && keys.composio() && (await hasActiveAppConnection("github"))) {
      return { source: "composio" };
    }
    if ((bot.connections.includes("github:env") || bot.connections.includes("github")) && envToken) {
      return { source: "env", token: envToken };
    }
    // If bot was only linked to a GitHub MCP server without a token, fall back to envToken only if set.
    if (envToken && botHasGithubPermission(bot, storedServers)) {
      return { source: "env", token: envToken };
    }
  } else {
    const srvWithToken = githubServers.find((s) => Boolean(s.token));
    if (srvWithToken?.token) return { source: "mcp", token: srvWithToken.token };
    if (keys.composio() && (await hasActiveAppConnection("github"))) return { source: "composio" };
    if (envToken) return { source: "env", token: envToken };
  }

  throw new InputError(
    "GitHub is not connected. Connect GitHub in Connections (add the GitHub MCP preset with a Personal Access Token, connect GitHub via Composio OAuth, or set GITHUB_TOKEN in .env) and retry.",
  );
}

export async function getWorkspaceGithubStatus(verifyLive = false): Promise<GithubConnectionStatus> {
  const storedServers = await listStoredServers();
  const mcpGithub = storedServers.find((s) => isGithubMcpServer(s) && Boolean(s.token));
  const envToken = envGithubToken();
  const composioConnected = keys.composio() ? await hasActiveAppConnection("github") : false;

  const source: GithubConnectionStatus["source"] = mcpGithub?.token
    ? "mcp"
    : composioConnected
      ? "composio"
      : envToken
        ? "env"
        : "none";

  if (source === "none") {
    return { configured: false, source: "none" };
  }

  if (source === "composio") {
    return { configured: true, source: "composio" };
  }

  const token = mcpGithub?.token || envToken!;
  if (!verifyLive) {
    return { configured: true, source };
  }

  try {
    const { data, headers } = await fetchGithubJson<{ login?: string }>("/user", token, 4_000);
    const scopeHeader = headers.get("x-oauth-scopes") ?? "";
    const scopes = scopeHeader
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      configured: true,
      source,
      login: data.login,
      scopes: scopes.length ? scopes : undefined,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const rejected = /401|Unauthorized/i.test(msg);
    return {
      configured: !rejected,
      source,
      error: msg,
    };
  }
}

export async function listGithubRepositories(bot: Bot | null, rawInput: unknown): Promise<GithubReposListResult> {
  const storedServers = await listStoredServers();
  if (bot && !botHasGithubPermission(bot, storedServers)) {
    throw new InputError(
      `GitHub is not enabled for ${bot.name}. Enable a GitHub connection in Connections and switch it on in ${bot.name}'s Details -> Connections first.`,
    );
  }

  const input = parseGithubReposListInput(rawInput);
  const auth = await resolveGithubAuth(bot, storedServers);
  const sort = input.sort ?? "updated";
  const allPages = Boolean(input.allPages);

  const seen = new Set<string>();
  const repositories: GithubRepoSummary[] = [];
  let page = input.page;
  let pagesFetched = 0;
  let hasNextPage = false;
  let nextPage: number | null = null;

  while (pagesFetched < MAX_PAGES) {
    let rawItems: unknown[] = [];
    let linkNext: number | null = null;

    if (auth.source === "composio") {
      const res = await executeComposioTool(
        "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
        {
          visibility: input.visibility,
          sort,
          per_page: input.perPage,
          page,
        },
        REQUEST_TIMEOUT_MS,
      );
      rawItems = extractRepoArray(res);
      linkNext = rawItems.length === input.perPage ? page + 1 : null;
    } else {
      const qs = new URLSearchParams({
        visibility: input.visibility,
        affiliation: "owner,collaborator,organization_member",
        sort,
        per_page: String(input.perPage),
        page: String(page),
      });
      const { data, headers } = await fetchGithubJson<unknown>(`/user/repos?${qs.toString()}`, auth.token, REQUEST_TIMEOUT_MS);
      rawItems = Array.isArray(data) ? data : extractRepoArray(data);
      linkNext = parseNextPageFromLinkHeader(headers.get("link"));
    }

    pagesFetched += 1;
    for (const item of rawItems) {
      const repo = normalizeRepo(item);
      if (!repo || seen.has(repo.full_name)) continue;
      seen.add(repo.full_name);
      repositories.push(repo);
    }

    const canAdvance = linkNext !== null ? linkNext > page : rawItems.length === input.perPage;
    if (!allPages) {
      hasNextPage = canAdvance;
      nextPage = canAdvance ? (linkNext ?? page + 1) : null;
      break;
    }
    if (!canAdvance || rawItems.length === 0) {
      hasNextPage = false;
      nextPage = null;
      break;
    }
    page = linkNext ?? page + 1;
    if (pagesFetched >= MAX_PAGES) {
      hasNextPage = true;
      nextPage = page;
      break;
    }
  }

  return {
    source: auth.source,
    totalCount: repositories.length,
    page: input.page,
    perPage: input.perPage,
    allPages,
    pagesFetched,
    hasNextPage,
    nextPage,
    repositories,
  };
}
