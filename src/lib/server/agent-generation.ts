import { Agent } from "@mastra/core/agent";
import type { AgentConfigurationResult, BotTools } from "@/lib/shared/types";
import { AgentConfigurationError, AgentConfigurationSchema, agentConfigurationToBotInput, simulatedAgentConfiguration, validateAgentConfiguration } from "./agent-config";
import { InputError } from "./errors";
import { isMock, keys } from "./config";
import { DEFAULT_MODEL, listModels } from "./models";

export class AgentGenerationError extends Error {}

function availableTools(): BotTools {
  return {
    webSearch: keys.tavily(),
    memory: true,
    codeMode: true,
    browser: keys.browserbase(),
    askUser: true,
  };
}

function generationPrompt(description: string, models: string[], tools: BotTools): string {
  return [
    "Generate a valid OpenCrewBot agent configuration for the user's description.",
    "Use only the exact existing tool fields webSearch, memory, codeMode, browser, and askUser. Do not invent tools, integrations, connections, or executable skills.",
    "Skills are short instruction hints only; no new skills runtime exists. Keep memory.enabled equal to tools.memory.",
    'Set approval to "ask" and both approvalPermissions fields to "ask". Never grant Full Access.',
    "Choose a model only from the provided model ids, and use a tool-capable model.",
    `Available models: ${JSON.stringify(models)}`,
    `Available tools (true means configured on this server): ${JSON.stringify(tools)}`,
    "If a requested tool is unavailable, leave it disabled. Do not claim unavailable tools in the instructions.",
    "Keep the name and title short, the description one sentence, skills concise, and expectedOutputFormat practical.",
    `User description:\n${description}`,
  ].join("\n\n");
}

export async function generateAgentConfiguration(rawDescription: unknown): Promise<AgentConfigurationResult> {
  if (typeof rawDescription !== "string" || !rawDescription.trim()) throw new InputError("Describe the agent you want to create.");
  const description = rawDescription.trim();
  if (description.length > 20_000) throw new InputError("Agent descriptions are limited to 20,000 characters.");

  const models = (await listModels()).filter((model) => model.tools);
  if (!models.length) throw new AgentGenerationError("No tool-capable models are available.");
  const tools = availableTools();
  const mode = isMock() ? "simulated" : "live";
  const generationModel = models.find((model) => model.id === DEFAULT_MODEL)?.id ?? models[0].id;
  let rawConfiguration: unknown;

  if (mode === "simulated") {
    rawConfiguration = simulatedAgentConfiguration(description, generationModel);
  } else {
    const designer = new Agent({
      id: "opencrewbot-agent-designer",
      name: "OpenCrewBot Agent Designer",
      instructions: "You design safe, useful agent configurations using only the supplied model and tool options.",
      model: `nebius/${generationModel}`,
    });
    try {
      const result = await designer.generate(generationPrompt(description, models.map((model) => model.id), tools), {
        maxSteps: 1,
        structuredOutput: { schema: AgentConfigurationSchema },
      });
      rawConfiguration = result.object;
    } catch (error) {
      console.error("[opencrewbot] AI agent configuration generation failed.", error);
      throw new AgentGenerationError("AI configuration generation failed. Check the configured model and try again.");
    }
  }

  let validated: ReturnType<typeof validateAgentConfiguration>;
  try {
    validated = validateAgentConfiguration(rawConfiguration, { models, availableTools: tools });
    const botInput = agentConfigurationToBotInput(validated.configuration);
    return {
      configuration: validated.configuration,
      botInput,
      mode,
      label: mode === "live" ? `AI-generated with ${generationModel}` : "Simulated configuration (mock mode; no AI inference)",
      unavailableTools: validated.unavailableTools,
    };
  } catch (error) {
    if (error instanceof AgentConfigurationError) {
      console.error("[opencrewbot] Generated agent configuration failed validation.", error.message);
      throw error;
    }
    throw error;
  }
}
