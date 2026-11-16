import { connection } from "next/server";
import type { ConnectionsState } from "@/lib/shared/types";
import { handle } from "@/lib/server/http";
import { keys } from "@/lib/server/config";
import { listApps } from "@/lib/server/composio";
import { getWorkspaceGithubStatus } from "@/lib/server/github";
import { listServers } from "@/lib/server/mcp-servers";
import { mcpServerNames } from "@/lib/server/connectors";

export async function GET() {
  await connection();
  return handle(async (): Promise<ConnectionsState> => {
    const [mcpServers, github] = await Promise.all([listServers(), getWorkspaceGithubStatus(true)]);
    for (const s of mcpServers) mcpServerNames.set(s.id, s.name);
    if (!keys.composio()) return { composio: { enabled: false, apps: [] }, mcpServers, github };
    try {
      return { composio: { enabled: true, apps: await listApps() }, mcpServers, github };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't reach Composio.";
      return { composio: { enabled: true, apps: [], error: message }, mcpServers, github };
    }
  });
}
