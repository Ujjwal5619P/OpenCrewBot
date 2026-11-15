// Connected apps through Composio: one key, OAuth handled by Composio, and
// hundreds of apps (Slack, GitHub, Gmail, Notion…). This install is one
// Composio "user"; every bot shares its connected accounts, and each bot only
// gets the apps you switch on for it.
import { randomUUID } from "node:crypto";
import { Composio } from "@composio/core";
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

/** Tools for the given apps, as one Composio session. Composio exposes a small set of
 * meta tools (search, then execute) instead of every action, which keeps the tool
 * list short enough for open models. */
export async function composioTools(slugs: string[]): Promise<ToolsInput> {
  const c = client();
  if (!c || slugs.length === 0) return {};
  const session = await c.create(await userId(), { toolkits: slugs, manageConnections: false });
  return (await session.tools()) as unknown as ToolsInput;
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
