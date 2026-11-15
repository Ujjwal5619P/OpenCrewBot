import { SkillDefinitionSchema, type SkillDefinition } from "./types";
import marketResearch from "./market-research";
import competitorAnalysis from "./competitor-analysis";
import financialModelling from "./financial-modelling";
import presentationCreation from "./presentation-creation";
import emailDrafting from "./email-drafting";
import codeReview from "./code-review";
import dataAnalysis from "./data-analysis";
import leadGeneration from "./lead-generation";
import type { SkillSummary } from "@/lib/shared/types";

export function validateSkillDefinitions(value: unknown): SkillDefinition[] {
  if (!Array.isArray(value)) throw new Error("Skill definitions must be an array.");
  const parsed = value.map((definition) => {
    const result = SkillDefinitionSchema.safeParse(definition);
    if (!result.success) throw new Error(`Invalid skill definition: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
    return result.data;
  });
  const ids = new Set<string>();
  for (const skill of parsed) {
    if (ids.has(skill.id)) throw new Error(`Duplicate skill ID: ${skill.id}`);
    ids.add(skill.id);
  }
  return parsed;
}

export const SKILLS = validateSkillDefinitions([
  marketResearch,
  competitorAnalysis,
  financialModelling,
  presentationCreation,
  emailDrafting,
  codeReview,
  dataAnalysis,
  leadGeneration,
]);

const skillById = new Map(SKILLS.map((skill) => [skill.id, skill]));

export function isSkillId(value: unknown): value is string {
  return typeof value === "string" && skillById.has(value);
}

export function validateSkillIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > SKILLS.length || value.some((id) => !isSkillId(id)) || new Set(value).size !== value.length) {
    throw new Error("Choose unique skills from the available skill library.");
  }
  return value;
}

export function discoverSkills(skillIds: readonly string[], availableTools: ReadonlySet<string>) {
  const assigned = new Set(skillIds.filter(isSkillId));
  return SKILLS.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    requiredTools: skill.requiredTools,
    assigned: assigned.has(skill.id),
    missingTools: skill.requiredTools.filter((tool) => !availableTools.has(tool)),
  }));
}

export function loadSkill(skillId: string, skillIds: readonly string[], availableTools: ReadonlySet<string>) {
  const skill = skillById.get(skillId);
  if (!skill) return { status: "unknown" as const };
  if (!skillIds.includes(skillId)) return { status: "not_assigned" as const, name: skill.name };
  const missingTools = skill.requiredTools.filter((tool) => !availableTools.has(tool));
  if (missingTools.length) return { status: "unavailable" as const, name: skill.name, missingTools };
  return {
    status: "loaded" as const,
    skill: {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      requiredTools: skill.requiredTools,
      instructions: skill.instructions,
    },
  };
}

export function listSkillSummaries(): SkillSummary[] {
  return SKILLS.map(({ id, name, description, requiredTools }) => ({ id, name, description, requiredTools }));
}
