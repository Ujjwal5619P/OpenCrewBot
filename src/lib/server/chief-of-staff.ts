import { Agent } from "@mastra/core/agent";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Bot, Execution, PlannerMode, TaskCapability } from "@/lib/shared/types";
import { InputError } from "./errors";
import { isMock } from "./config";
import { listBots } from "./db";
import { DEFAULT_MODEL } from "./models";
import { createExecutionTasks } from "./execution-core";

const PLAN_LIMIT = 30;

const PlanSchema = z.object({
  summary: z.string().trim().min(1).max(1000),
  tasks: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        title: z.string().trim().min(1).max(120),
        description: z.string().trim().min(1).max(20_000),
        assignedBotId: z.string().min(1).max(100),
        requiredCapabilities: z
          .array(
            z.enum(["research", "writing", "planning", "analysis", "webSearch", "memory", "codeMode", "browser", "connectedApps", "askUser"]),
          )
          .max(10),
        dependencies: z.array(z.string().min(1).max(64)).max(PLAN_LIMIT),
      }),
    )
    .min(1)
    .max(PLAN_LIMIT),
});

type PlanDraft = z.infer<typeof PlanSchema>;

function choosePlanner(bots: Bot[]): Bot {
  const score = (bot: Bot) => {
    const text = `${bot.name} ${bot.title} ${bot.description}`.toLowerCase();
    return ["chief of staff", "planning", "planner", "strategy", "project manager"].reduce(
      (total, word) => total + (text.includes(word) ? (word === "chief of staff" ? 5 : 2) : 0),
      0,
    );
  };
  return bots.slice().sort((a, b) => score(b) - score(a) || a.createdAt.localeCompare(b.createdAt))[0];
}

function botFor(text: string, bots: Bot[]): Bot {
  const words = new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((word) => !["the", "and", "for", "with", "that", "this"].includes(word)));
  const score = (bot: Bot) => {
    const profile = `${bot.name} ${bot.title} ${bot.description} ${bot.instructions}`.toLowerCase();
    let value = [...words].reduce((total, word) => total + (profile.includes(word) ? 1 : 0), 0);
    if (/\b(research|search|source|find|investigate|compare)\b/i.test(text) && bot.tools.webSearch) value += 3;
    if (/\b(write|draft|compose|email|article|post)\b/i.test(text) && /writ|edit|content|communicat/i.test(profile)) value += 3;
    if (/\b(plan|organize|strategy|roadmap)\b/i.test(text) && /plan|strateg|project/i.test(profile)) value += 3;
    return value;
  };
  return bots.slice().sort((a, b) => score(b) - score(a) || a.createdAt.localeCompare(b.createdAt))[0];
}

function simulatedPlan(instruction: string, bots: Bot[]): PlanDraft {
  const steps = instruction
    .split(/\b(?:then|after that|afterwards)\b|;|\n|[.!?]\s+/i)
    .map((step) => step.trim())
    .filter(Boolean);
  const segments = steps.length > 1 ? steps : [instruction.trim()];
  const researchIndex = segments.findIndex((segment) => /\b(research|search|find|source|investigate|compare)\b/i.test(segment));
  const tasks = segments.map((segment, index) => {
    const title = segment.length > 100 ? `${segment.slice(0, 97).trimEnd()}...` : segment;
    const dependsOnResearch =
      researchIndex >= 0 &&
      index !== researchIndex &&
      /\b(write|draft|summari[sz]|recommend|report|analy[sz])\b/i.test(segment);
    return {
      id: `task-${index + 1}`,
      title,
      description: segment,
      assignedBotId: botFor(segment, bots).id,
      requiredCapabilities: taskCapabilities(segment),
      dependencies: dependsOnResearch ? [`task-${researchIndex + 1}`] : [],
    };
  });
  return { summary: "Simulated task breakdown; no AI planning inference was used.", tasks };
}

function taskCapabilities(text: string): TaskCapability[] {
  const capabilities: TaskCapability[] = [];
  if (/\b(research|search|find|source|investigate|compare)\b/i.test(text)) capabilities.push("research", "webSearch");
  if (/\b(write|draft|compose|email|article|post)\b/i.test(text)) capabilities.push("writing");
  if (/\b(plan|organize|strategy|roadmap)\b/i.test(text)) capabilities.push("planning");
  if (/\b(analy[sz]e|review|evaluate|compare)\b/i.test(text)) capabilities.push("analysis");
  if (/\b(memory|remember)\b/i.test(text)) capabilities.push("memory");
  if (/\b(code|implement|script|program)\b/i.test(text)) capabilities.push("codeMode");
  if (/\b(browser|open the site|click|navigate)\b/i.test(text)) capabilities.push("browser");
  if (/\b(app|slack|github|gmail|notion|mcp)\b/i.test(text)) capabilities.push("connectedApps");
  if (/\b(ask me|clarify|ask the user)\b/i.test(text)) capabilities.push("askUser");
  return [...new Set(capabilities)];
}

function planningPrompt(instruction: string, bots: Bot[]): string {
  const roster = bots.map((bot) => ({
    id: bot.id,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    instructions: bot.instructions.slice(0, 1200),
    capabilities: {
      webSearch: bot.tools.webSearch,
      memory: bot.tools.memory,
      codeMode: bot.tools.codeMode,
      browser: bot.tools.browser,
      connections: bot.connections.length > 0,
    },
    approvalMode: bot.approval,
  }));
  return [
    "Create a practical task plan for the user's request.",
    "Return only tasks that can be performed by the listed bots. Assign each task to exactly one listed bot ID.",
    "Use unique short task IDs containing only letters, numbers, underscores, or hyphens. Dependencies must refer to task IDs.",
    "Make independent tasks dependency-free so they can run concurrently. Add dependencies only when required by the work.",
    "List each task's requiredCapabilities using these labels when applicable: research, writing, planning, analysis, webSearch, memory, codeMode, browser, connectedApps, askUser.",
    "Do not claim capabilities or integrations that the bot roster does not provide.",
    `User request:\n${instruction}`,
    `Available bots:\n${JSON.stringify(roster)}`,
  ].join("\n\n");
}

function makeExecution(
  instruction: string,
  draft: PlanDraft,
  bots: Bot[],
  plannerMode: PlannerMode,
  plannerLabel: string,
): Execution {
  let tasks: ReturnType<typeof createExecutionTasks>;
  try {
    tasks = createExecutionTasks(draft.tasks, bots);
  } catch (error) {
    throw new InputError(error instanceof Error ? error.message : "The generated task plan is invalid.");
  }
  return {
    id: randomUUID(),
    instruction,
    summary: draft.summary,
    plannerMode,
    plannerLabel,
    status: "pending",
    tasks,
    createdAt: new Date().toISOString(),
  };
}

export async function planExecution(rawInstruction: unknown): Promise<Execution> {
  if (typeof rawInstruction !== "string" || !rawInstruction.trim()) throw new InputError("Provide a non-empty instruction.");
  const instruction = rawInstruction.trim();
  if (instruction.length > 20_000) throw new InputError("Instructions are limited to 20,000 characters.");

  const bots = await listBots();
  if (!bots.length) throw new InputError("Create at least one bot before starting an execution.");

  if (isMock()) {
    const draft = PlanSchema.parse(simulatedPlan(instruction, bots));
    return makeExecution(instruction, draft, bots, "simulated", "Simulated planning (mock mode)");
  }

  const plannerBot = choosePlanner(bots);
  let draft: PlanDraft;
  try {
    const planner = new Agent({
      id: `chief-of-staff-${plannerBot.id}`,
      name: "Chief of Staff",
      instructions:
        "You are the OpenCrewBot Chief of Staff. Produce concise, executable plans using only the available bots. A task marked dependent must wait for its dependencies.",
      model: `nebius/${plannerBot.model || DEFAULT_MODEL}`,
    });
    const result = await planner.generate(planningPrompt(instruction, bots), {
      maxSteps: 1,
      structuredOutput: { schema: PlanSchema },
    });
    draft = PlanSchema.parse(result.object);
  } catch (error) {
    console.error("[opencrewbot] AI task planning failed.", error);
    throw new Error("AI planning failed. Check the configured model and try again.");
  }
  return makeExecution(instruction, draft, bots, "ai", `AI planning via ${plannerBot.name}`);
}
