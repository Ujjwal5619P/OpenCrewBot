import type { SkillDefinition } from "./types";

const skill: SkillDefinition = {
  id: "email-drafting",
  name: "Email Drafting",
  description: "Draft clear, audience-appropriate email messages for review.",
  instructions:
    "Identify the recipient, purpose, tone, and desired next step. Draft a concise subject and message, preserve facts supplied by the person, and mark missing details rather than inventing them. Drafting does not send an email; any Gmail action uses the bot's configured connection and existing approval policy.",
  requiredTools: [],
};

export default skill;
