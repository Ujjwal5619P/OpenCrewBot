import type { SkillDefinition } from "./types";

const skill: SkillDefinition = {
  id: "market-research",
  name: "Market Research",
  description: "Research a market using current sources and clearly separated evidence, estimates, and unknowns.",
  instructions:
    "Define the market and time period before drawing conclusions. Search for current primary and reputable sources, compare independent evidence, and cite URLs for factual claims. Separate sourced facts from estimates and identify gaps; do not invent market size or trends.",
  requiredTools: ["web_search", "read_page"],
};

export default skill;
