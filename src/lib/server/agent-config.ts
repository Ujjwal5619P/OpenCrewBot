import { z } from "zod";
import type { AgentConfiguration, BotInput, BotTools, ModelOption } from "@/lib/shared/types";

const toolsSchema = z
  .object({
    webSearch: z.boolean(),
    memory: z.boolean(),
    codeMode: z.boolean(),
    browser: z.boolean(),
    askUser: z.boolean(),
  })
  .strict();

export const AgentConfigurationSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    title: z.string().trim().min(1).max(40),
    description: z.string().trim().min(1).max(200),
    instructions: z.string().trim().min(1).max(6000),
    model: z.string().trim().min(1).max(160),
    tools: toolsSchema,
    skills: z.array(z.string().trim().min(1).max(60)).min(1).max(8),
    memory: z
      .object({
        enabled: z.boolean(),
        guidance: z.string().trim().min(1).max(300),
      })
      .strict(),
    approval: z.literal("ask"),
    approvalPermissions: z
      .object({
        browserActions: z.literal("ask"),
        connectedAppActions: z.literal("ask"),
      })
      .strict(),
    expectedOutputFormat: z.string().trim().min(1).max(800),
  })
  .strict();

export type ParsedAgentConfiguration = z.infer<typeof AgentConfigurationSchema>;

export class AgentConfigurationError extends Error {}

export interface AgentConfigurationConstraints {
  models: readonly Pick<ModelOption, "id" | "tools">[];
  availableTools: BotTools;
}

export function validateAgentConfiguration(value: unknown, constraints: AgentConfigurationConstraints) {
  const parsed = AgentConfigurationSchema.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`);
    throw new AgentConfigurationError(`The generated configuration is invalid: ${details.join("; ")}`);
  }
  if (parsed.data.memory.enabled !== parsed.data.tools.memory) {
    throw new AgentConfigurationError("Memory configuration must match the memory tool.");
  }
  const skills = new Set<string>();
  for (const skill of parsed.data.skills) {
    const key = skill.toLowerCase();
    if (skills.has(key)) throw new AgentConfigurationError(`Duplicate skill: ${skill}`);
    skills.add(key);
  }
  const model = constraints.models.find((candidate) => candidate.id === parsed.data.model);
  if (!model) throw new AgentConfigurationError("Choose a model from the available model catalog.");
  if (!model.tools && Object.values(parsed.data.tools).some(Boolean)) {
    throw new AgentConfigurationError("The selected model cannot use the configured tools.");
  }

  const configuration: AgentConfiguration = parsed.data;
  const unavailableTools: ("webSearch" | "browser")[] = [];
  const safeTools = { ...configuration.tools };
  for (const key of ["webSearch", "browser"] as const) {
    if (safeTools[key] && !constraints.availableTools[key]) {
      safeTools[key] = false;
      unavailableTools.push(key);
    }
  }
  return { configuration: { ...configuration, tools: safeTools }, unavailableTools };
}

export function simulatedAgentConfiguration(description: string, model: string): AgentConfiguration {
  const roleMatch = description.match(/(?:create|build|design|make)\s+(?:a|an)\s+(.+?)(?:\s+(?:that|which|who)\b|[,.!?]|$)/i);
  const role = (roleMatch?.[1] ?? "Specialist Agent").replace(/\b(agent|assistant)\b/gi, "").trim() || "Specialist Agent";
  const name = role
    .split(/\s+/)
    .slice(0, 4)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ")
    .slice(0, 40);
  const normalized = description.toLowerCase();
  const asksForMemory = /\b(memory|remember|remembers|retain|findings)\b/.test(normalized);
  const tools: BotTools = {
    webSearch: /\b(web|search|research|sources?|vulnerabilit|cybersecurity)\b/.test(normalized),
    memory: asksForMemory,
    codeMode: /\b(code|analys[ei]s|vulnerabilit|program|script|cybersecurity)\b/.test(normalized),
    browser: /\b(browser|navigate|click|websites?|sites?)\b/.test(normalized),
    askUser: true,
  };
  const skills = [
    ...(tools.webSearch ? ["Focused web research"] : []),
    ...(tools.codeMode ? ["Code and technical analysis"] : []),
    ...(asksForMemory ? ["Maintain relevant findings in private memory"] : []),
    ...(/\b(report|structured|format)\b/.test(normalized) ? ["Produce structured reports"] : []),
  ];
  if (!skills.length) skills.push("Specialized assistance based on the request");
  const summary = description.trim().replace(/\s+/g, " ");
  const outputFormat = /\b(report|structured|findings)\b/.test(normalized)
    ? "Structured report with an executive summary, findings, evidence, and recommendations."
    : "A concise, clearly organized response with conclusions and relevant caveats.";

  return {
    name: name || "Specialist Agent",
    title: name || "Specialist",
    description: summary.length > 200 ? `${summary.slice(0, 197).trimEnd()}...` : summary,
    instructions: `You are a specialized assistant for ${role}. Follow this requested scope: ${summary}. Be accurate, state uncertainty clearly, and do not claim access to tools that are disabled.`,
    model,
    tools,
    skills: [...new Set(skills)].slice(0, 8),
    memory: {
      enabled: tools.memory,
      guidance: tools.memory ? "Store durable, relevant findings in this agent's private MEMORY.md." : "Memory is disabled; do not claim to retain information between turns.",
    },
    approval: "ask",
    approvalPermissions: { browserActions: "ask", connectedAppActions: "ask" },
    expectedOutputFormat: outputFormat,
  };
}

export function agentConfigurationToBotInput(configuration: AgentConfiguration): BotInput {
  const instructions = [
    configuration.instructions.trim(),
    `## Specialist skills\n${configuration.skills.map((skill) => `- ${skill}`).join("\n")}`,
    `## Memory guidance\n${configuration.memory.guidance}`,
    `## Expected output format\n${configuration.expectedOutputFormat}`,
  ].join("\n\n");
  if (instructions.length > 8000) throw new AgentConfigurationError("The combined instructions exceed the 8,000-character limit.");

  return {
    name: configuration.name,
    title: configuration.title,
    description: configuration.description,
    instructions,
    model: configuration.model,
    tools: { ...configuration.tools },
    approval: "ask",
    emoji: "🤖",
    color: "#3b82f6",
    pinned: false,
    connections: [],
  };
}
