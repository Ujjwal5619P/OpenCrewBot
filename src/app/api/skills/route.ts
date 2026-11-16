import { connection } from "next/server";
import { handle } from "@/lib/server/http";
import { listSkills } from "@/lib/server/skills";

export async function GET() {
  await connection();
  return handle(async () => ({ skills: listSkills() }));
}
