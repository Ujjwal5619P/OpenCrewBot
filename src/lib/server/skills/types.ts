import { z } from "zod";

export const SKILL_TOOL_IDS = ["web_search", "read_page", "execute_typescript", "COMPOSIO_MULTI_EXECUTE_TOOL"] as const;

export const SkillDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(300),
    instructions: z.string().trim().min(1).max(4_000),
    requiredTools: z.array(z.enum(SKILL_TOOL_IDS)).max(8),
  })
  .strict();

export type SkillDefinition = z.infer<typeof SkillDefinitionSchema>;
