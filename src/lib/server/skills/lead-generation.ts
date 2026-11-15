import type { SkillDefinition } from "./types";

const skill: SkillDefinition = {
  id: "lead-generation",
  name: "Lead Generation",
  description: "Identify and qualify potential leads from public, relevant sources.",
  instructions:
    "Confirm the target profile and geography. Use public, relevant sources and include evidence and source URLs for each proposed lead. Do not infer private contact details or claim outreach was sent. Any connected-app action remains subject to existing tool permissions and approval.",
  requiredTools: ["web_search", "read_page"],
};

export default skill;
