import { body, handle } from "@/lib/server/http";
import { AgentConfigurationError } from "@/lib/server/agent-config";
import { AgentGenerationError, generateAgentConfiguration } from "@/lib/server/agent-generation";
import { InputError } from "@/lib/server/errors";

export async function POST(request: Request) {
  return handle(async () => {
    const payload = await body<unknown>(request);
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new InputError("Expected a JSON object.");
    }
    const { description } = payload as { description?: unknown };
    try {
      return { ...(await generateAgentConfiguration(description)) };
    } catch (error) {
      if (error instanceof AgentConfigurationError) return Response.json({ error: error.message }, { status: 422 });
      if (error instanceof AgentGenerationError) return Response.json({ error: error.message }, { status: 502 });
      throw error;
    }
  });
}
