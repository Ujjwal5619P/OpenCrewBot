import { createHash } from "node:crypto";
import type { CollaborationTaskSpec } from "@/lib/shared/types";

export const MAX_DELEGATION_DEPTH = 3;

export function validateDelegationDepth(depth: number): void {
  if (depth >= MAX_DELEGATION_DEPTH) throw new Error(`Maximum delegation depth (${MAX_DELEGATION_DEPTH}) reached.`);
}

export function validateCollaborationPlan(
  tasks: CollaborationTaskSpec[],
  memberIds: ReadonlySet<string>,
  delegatorBotId: string,
): void {
  if (tasks.length < 1 || tasks.length > 20) throw new Error("A delegation must contain between 1 and 20 tasks.");
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(task.id)) throw new Error(`Invalid task id: ${task.id}`);
    if (ids.has(task.id)) throw new Error(`Duplicate delegated task id: ${task.id}`);
    ids.add(task.id);
    if (!memberIds.has(task.assignedBotId)) throw new Error(`Task ${task.id} must be assigned to a member of this room.`);
    if (task.assignedBotId === delegatorBotId) throw new Error(`Task ${task.id} must be assigned to another room member.`);
    if (!task.objective.trim() || !task.expectedOutput.trim()) throw new Error(`Task ${task.id} needs an objective and expected output.`);
  }
  for (const task of tasks) {
    if (task.verificationOfTaskId && (!ids.has(task.verificationOfTaskId) || !task.dependencies.includes(task.verificationOfTaskId))) {
      throw new Error(`Verification task ${task.id} must depend on the task it reviews.`);
    }
  }
}

export function delegationPattern(tasks: CollaborationTaskSpec[], botId: string): string {
  const normalized = tasks
    .map((task) => `${task.assignedBotId}:${task.objective.toLowerCase().replace(/\s+/g, " ").trim()}`)
    .sort()
    .join("|");
  return createHash("sha256").update(`${botId}|${normalized}`).digest("hex");
}

export function verificationVerdict(output: string): "accepted" | "needs_revision" | "inconclusive" {
  const verdict = output.split(/\r?\n/, 1)[0].match(/^VERDICT:\s*(ACCEPTED|NEEDS_REVISION)\s*$/i)?.[1]?.toUpperCase();
  return verdict === "ACCEPTED" ? "accepted" : verdict === "NEEDS_REVISION" ? "needs_revision" : "inconclusive";
}
