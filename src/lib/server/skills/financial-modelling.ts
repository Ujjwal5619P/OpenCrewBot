import type { SkillDefinition } from "./types";

const skill: SkillDefinition = {
  id: "financial-modelling",
  name: "Financial Modelling",
  description: "Build transparent, assumption-led financial models and scenario analyses.",
  instructions:
    "State the model objective, units, period, inputs, and assumptions. Show formulas and a base case plus relevant sensitivities. Validate arithmetic with the available calculation tool, label estimates as estimates, and never present the result as financial advice.",
  requiredTools: ["execute_typescript"],
};

export default skill;
