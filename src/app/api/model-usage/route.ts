import { connection } from "next/server";
import { modelUsageSummary } from "@/lib/server/db";
import { handle } from "@/lib/server/http";

export async function GET() {
  await connection();
  return handle(async () => ({ usage: await modelUsageSummary() }));
}
