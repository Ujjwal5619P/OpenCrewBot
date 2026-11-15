import type { SkillDefinition } from "./types";

const skill: SkillDefinition = {
  id: "data-analysis",
  name: "Data Analysis",
  description: "Analyze supplied structured data with explicit methods and reproducible calculations.",
  instructions:
    "Check the data shape, units, missing values, and relevant time window before analysis. Use calculations for non-trivial arithmetic, explain the method, distinguish correlation from causation, and state limits that affect the conclusion.",
  requiredTools: ["execute_typescript"],
};

export default skill;
