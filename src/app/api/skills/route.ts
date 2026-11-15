import { connection } from "next/server";
import { handle } from "@/lib/server/http";
import { listSkillSummaries } from "@/lib/server/skills/catalog";

export async function GET() {
  await connection();
  return handle(async () => ({ skills: listSkillSummaries() }));
}
