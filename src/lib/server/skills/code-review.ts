import type { SkillDefinition } from "./types";

const skill: SkillDefinition = {
  id: "code-review",
  name: "Code Review",
  description: "Review supplied code or diffs for correctness, regressions, and maintainability.",
  instructions:
    "Review only the code or diff provided in context. Prioritize concrete correctness and security issues, cite file and line references when available, and distinguish confirmed bugs from questions. Do not claim to inspect repository files unless a configured tool actually provides them.",
  requiredTools: [],
};

export default skill;
