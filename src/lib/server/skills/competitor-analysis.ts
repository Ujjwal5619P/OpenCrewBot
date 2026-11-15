import type { SkillDefinition } from "./types";

const skill: SkillDefinition = {
  id: "competitor-analysis",
  name: "Competitor Analysis",
  description: "Compare competitors on a defined set of evidence-backed dimensions.",
  instructions:
    "Confirm the comparison scope and date. Compare products, audience, positioning, pricing, distribution, and stated differentiators only where evidence exists. Cite sources, mark unavailable data, and distinguish observed facts from analysis.",
  requiredTools: ["web_search", "read_page"],
};

export default skill;
