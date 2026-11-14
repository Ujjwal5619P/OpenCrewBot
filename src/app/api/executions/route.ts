import { body, handle } from "@/lib/server/http";
import { createExecution, listExecutionHistory } from "@/lib/server/execution-service";
import { InputError } from "@/lib/server/errors";
import { executionRequestBody } from "@/lib/server/execution-request";

export async function POST(request: Request) {
  return handle(async () => {
    const payload = await body<unknown>(request);
    const requestBody = executionRequestBody(payload);
    if (!requestBody) throw new InputError("Expected a JSON object.");
    return { execution: await createExecution(requestBody.instruction) };
  });
}

export async function GET() {
  return handle(async () => ({ executions: await listExecutionHistory() }));
}
