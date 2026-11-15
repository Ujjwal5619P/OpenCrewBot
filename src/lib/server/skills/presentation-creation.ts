import type { SkillDefinition } from "./types";

const skill: SkillDefinition = {
  id: "presentation-creation",
  name: "Presentation Creation",
  description: "Turn a brief into a coherent slide-by-slide presentation draft.",
  instructions:
    "Clarify the audience, objective, and time available. Create a narrative arc, then draft concise slide titles, key points, and suggested visuals. Flag unsupported claims and provide speaker notes when useful. This skill drafts content; it does not create or upload a presentation file.",
  requiredTools: [],
};

export default skill;
