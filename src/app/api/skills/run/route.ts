import { body, handle } from "@/lib/server/http";
import { runSkill } from "@/lib/server/skills";

export async function POST(request: Request) {
  return handle(async () => {
    const { skillId, input } = await body<{ skillId: string; input?: Record<string, unknown> }>(request);
    return { result: await runSkill(skillId, input) };
  });
}
