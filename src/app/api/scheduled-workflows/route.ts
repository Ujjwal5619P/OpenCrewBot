import { body, handle } from "@/lib/server/http";
import { createWorkflow, listWorkflowRuns, listWorkflows } from "@/lib/server/scheduled-workflows";
import { InputError } from "@/lib/server/errors";
import { z } from "zod";

const WorkflowIdSchema = z.string().uuid();
const DEFAULT_HISTORY_LIMIT = 8;
const MAX_HISTORY_LIMIT = 100;
const MAX_HISTORY_OFFSET = 1_000_000;

function queryInteger(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const values = params.getAll(name);
  if (values.length > 1) throw new InputError(`Provide only one ${name} value.`);
  const raw = values[0];
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new InputError(`Provide a valid ${name}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new InputError(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

export async function GET(request: Request) {
  return handle(async () => {
    const params = new URL(request.url).searchParams;
    const workflowIds = params.getAll("workflowId");
    if (workflowIds.length > 1) throw new InputError("Provide only one workflowId value.");
    const workflowId = workflowIds[0];
    if (workflowId !== undefined && !WorkflowIdSchema.safeParse(workflowId).success) {
      throw new InputError("Provide a valid workflow ID.");
    }

    if (workflowId === undefined && (params.has("limit") || params.has("offset"))) {
      throw new InputError("Pagination requires a workflowId.");
    }

    if (workflowId !== undefined) {
      const limit = queryInteger(params, "limit", DEFAULT_HISTORY_LIMIT, 1, MAX_HISTORY_LIMIT);
      const offset = queryInteger(params, "offset", 0, 0, MAX_HISTORY_OFFSET);
      const fetchedRuns = await listWorkflowRuns(workflowId, limit + 1, offset);
      return {
        workflows: [],
        runs: fetchedRuns.slice(0, limit),
        pagination: { workflowId, limit, offset, hasMore: fetchedRuns.length > limit },
      };
    }

    const workflows = await listWorkflows();
    const latestRuns = await Promise.all(workflows.map((workflow) => listWorkflowRuns(workflow.id, 1)));
    return {
      workflows,
      runs: latestRuns.flat(),
      pagination: null,
    };
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const payload = await body<unknown>(request);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new InputError("Expected a scheduled workflow object.");
    }
    return { workflow: await createWorkflow(payload) };
  });
}
