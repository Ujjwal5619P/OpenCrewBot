import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CollaborationMessage, CollaborationTaskSpec, Execution } from "@/lib/shared/types";
import { InputError } from "./errors";
import * as store from "./db";
import { createDelegatedExecution } from "./execution-service";
import { delegationPattern, validateCollaborationPlan, validateDelegationDepth } from "./collaboration-core";

const MAX_MESSAGES_PER_HOUR = 60;

const TaskSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  title: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(4_000),
  context: z.string().trim().max(8_000),
  expectedOutput: z.string().trim().min(1).max(2_000),
  assignedBotId: z.string().min(1).max(100),
  dependencies: z.array(z.string().min(1).max(64)).max(20),
  verificationOfTaskId: z.string().min(1).max(64).optional(),
}).strict();

const DelegationSchema = z.object({
  tasks: z.array(TaskSchema).min(1).max(20),
}).strict();

const MessageSchema = z.object({
  type: z.enum(["research", "question", "answer"]),
  content: z.string().trim().min(1).max(8_000),
  recipientBotId: z.string().min(1).max(100).optional(),
  responseToMessageId: z.string().min(1).max(100).optional(),
}).strict();

interface RoomContext {
  roomId: string;
  room: NonNullable<Awaited<ReturnType<typeof store.getRoom>>>;
  depth: number;
  execution?: Execution;
  path: string[];
}

function threadConversation(threadId: string, botId: string): string {
  const marker = `:${botId}:`;
  const index = threadId.lastIndexOf(marker);
  if (index <= 0 || !/^\d+$/.test(threadId.slice(index + marker.length))) {
    throw new InputError("Collaboration tools are available only in an active room or delegated task.");
  }
  return threadId.slice(0, index);
}

async function roomContext(botId: string, threadId: string): Promise<RoomContext> {
  const conversationId = threadConversation(threadId, botId);
  let roomId: string;
  let execution: Execution | undefined;
  if (conversationId.startsWith("room:")) {
    roomId = conversationId.slice("room:".length);
  } else {
    const match = conversationId.match(/^execution:([^:]+):task:([^:]+)$/);
    if (!match) throw new InputError("Collaboration tools are available only in a room context.");
    execution = await store.getExecution(match[1]) ?? undefined;
    if (!execution?.collaboration || execution.status !== "running") {
      throw new InputError("The parent collaboration execution is no longer active.");
    }
    const parentTask = execution.tasks.find((task) => task.id === match[2]);
    if (!parentTask || parentTask.assignedBotId !== botId || parentTask.status !== "running") {
      throw new InputError("This agent is not authorized to delegate from that task.");
    }
    roomId = execution.collaboration.roomId;
  }
  const room = await store.getRoom(roomId);
  if (!room || !room.memberIds.includes(botId)) throw new InputError("This agent is not a member of that room.");
  return {
    roomId,
    room,
    depth: execution?.collaboration?.depth ?? 0,
    execution,
    path: execution?.collaboration?.path ?? [],
  };
}

function newMessage(
  context: RoomContext,
  authorBotId: string,
  type: CollaborationMessage["type"],
  content: string,
  extras: Partial<Pick<CollaborationMessage, "executionId" | "taskId" | "recipientBotId" | "responseToMessageId">> = {},
): CollaborationMessage {
  return {
    id: randomUUID(),
    roomId: context.roomId,
    createdAt: new Date().toISOString(),
    authorBotId,
    type,
    content,
    ...extras,
  };
}

async function withinMessageLimit(roomId: string, needed = 1): Promise<boolean> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return (await store.countRecentCollaborationMessages(roomId, since)) + needed <= MAX_MESSAGES_PER_HOUR;
}

function ensureActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new InputError("The parent task was cancelled.");
}

async function recordRejection(context: RoomContext, botId: string, reason: string): Promise<void> {
  if (!(await withinMessageLimit(context.roomId))) {
    console.warn("[opencrewbot] Collaboration delegation rejected because the room message limit was reached.");
    return;
  }
  await store.saveCollaborationMessage(newMessage(context, botId, "delegation_rejected", reason));
}

export async function delegateRoomWork(botId: string, threadId: string, rawInput: unknown, signal?: AbortSignal) {
  const context = await roomContext(botId, threadId);
  try {
    ensureActive(signal);
    const parsed = DelegationSchema.safeParse(rawInput);
    if (!parsed.success) throw new InputError("Delegation must include 1-20 valid, structured tasks.");
    const tasks = parsed.data.tasks as CollaborationTaskSpec[];
    try {
      validateCollaborationPlan(tasks, new Set(context.room.memberIds), botId);
    } catch (error) {
      throw new InputError(error instanceof Error ? error.message : "The delegated task plan is invalid.");
    }
    try {
      validateDelegationDepth(context.depth);
    } catch (error) {
      throw new InputError(error instanceof Error ? error.message : "Maximum delegation depth reached.");
    }
    const pattern = delegationPattern(tasks, botId);
    if (context.path.includes(pattern)) throw new InputError("Repeated delegation pattern rejected to prevent a loop.");
    const activeRoomExecutions = await store.listRoomExecutions(context.roomId);
    if (
      activeRoomExecutions.some(
        (execution) =>
          (execution.status === "pending" || execution.status === "running") &&
          execution.collaboration?.path.includes(pattern),
      )
    ) {
      throw new InputError("An identical delegation is already active in this room.");
    }
    const messageCount = 1 + tasks.filter((task) => task.verificationOfTaskId).length;
    if (!(await withinMessageLimit(context.roomId, messageCount))) {
      throw new InputError("The room has reached its collaboration-message limit for this hour.");
    }
    const messages = [
      newMessage(
        context,
        botId,
        "delegation",
        `Delegated ${tasks.length} task${tasks.length === 1 ? "" : "s"} to room members.`,
      ),
      ...tasks
        .filter((task) => task.verificationOfTaskId)
        .map((task) =>
          newMessage(
            context,
            botId,
            "verification_request",
            `${task.title} will verify findings from task ${task.verificationOfTaskId}.`,
            { taskId: task.id, recipientBotId: task.assignedBotId },
          ),
        ),
    ];
    const instruction = tasks.map((task) => `${task.title}: ${task.objective}`).join("\n");
    ensureActive(signal);
    const execution = await createDelegatedExecution({
      roomId: context.roomId,
      instruction,
      summary: `Room collaboration: ${tasks.length} delegated task${tasks.length === 1 ? "" : "s"}`,
      tasks,
      metadata: {
        roomId: context.roomId,
        parentExecutionId: context.execution?.id,
        rootExecutionId: context.execution?.collaboration?.rootExecutionId ?? randomUUID(),
        depth: context.depth + 1,
        delegatorBotId: botId,
        path: [...context.path, pattern],
        patternKey: pattern,
      },
      messages,
      parentSignal: signal,
    });
    return { executionId: execution.id, status: execution.status, taskCount: execution.tasks.length };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The delegated plan is invalid.";
    if (!signal?.aborted) {
      try {
        await recordRejection(context, botId, reason);
      } catch (recordError) {
        console.error("[opencrewbot] Could not persist a collaboration rejection.", recordError);
      }
    }
    throw error;
  }
}

export async function sendRoomCollaborationMessage(
  botId: string,
  threadId: string,
  rawInput: unknown,
  signal?: AbortSignal,
) {
  const context = await roomContext(botId, threadId);
  ensureActive(signal);
  const parsed = MessageSchema.safeParse(rawInput);
  if (!parsed.success) throw new InputError("Provide a valid collaboration message.");
  const input = parsed.data;
  const isQuestion = input.type === "question";
  if (!(await withinMessageLimit(context.roomId, isQuestion ? 2 : 1))) {
    throw new InputError("The room has reached its collaboration-message limit for this hour.");
  }
  if (input.recipientBotId && !context.room.memberIds.includes(input.recipientBotId)) {
    throw new InputError("The recipient must be a member of this room.");
  }
  if (input.type === "question" && (!input.recipientBotId || input.recipientBotId === botId)) {
    throw new InputError("Questions must be addressed to another room member.");
  }
  let responseToMessageId: string | undefined;
  if (input.type === "answer") {
    if (!input.responseToMessageId) throw new InputError("An answer must reference a room question.");
    const question = await store.getCollaborationMessage(input.responseToMessageId);
    if (
      !question ||
      question.roomId !== context.roomId ||
      question.type !== "question" ||
      question.authorBotId === botId ||
      (question.recipientBotId && question.recipientBotId !== botId)
    ) {
      throw new InputError("That question is unavailable or not addressed to this agent.");
    }
    if (await store.hasCollaborationAnswer(question.id)) throw new InputError("That question already has an answer.");
    responseToMessageId = question.id;
  }
  const message = newMessage(context, botId, input.type, input.content, {
    recipientBotId: input.recipientBotId,
    responseToMessageId,
    executionId: context.execution?.id,
  });
  ensureActive(signal);
  if (isQuestion && input.recipientBotId) {
    try {
      validateDelegationDepth(context.depth);
      const task: CollaborationTaskSpec = {
        id: `answer-${message.id.slice(0, 12)}`,
        title: "Answer room question",
        objective: `Answer the room question from ${botId}. Use the existing room_collaborate tool to post the answer.`,
        context: `Question message ID: ${message.id}\nQuestion: ${input.content}`,
        expectedOutput: `Post an answer with type="answer" and responseToMessageId="${message.id}".`,
        assignedBotId: input.recipientBotId,
        dependencies: [],
      };
      const pattern = delegationPattern([task], botId);
      if (context.path.includes(pattern)) throw new InputError("Repeated question delegation rejected to prevent a loop.");
      const activeRoomExecutions = await store.listRoomExecutions(context.roomId);
      if (
        activeRoomExecutions.some(
          (execution) =>
            (execution.status === "pending" || execution.status === "running") &&
            execution.collaboration?.path.includes(pattern),
        )
      ) {
        throw new InputError("An identical question response is already active in this room.");
      }
      ensureActive(signal);
      const execution = await createDelegatedExecution({
        roomId: context.roomId,
        instruction: task.objective,
        summary: "Room question response",
        tasks: [task],
        metadata: {
          roomId: context.roomId,
          parentExecutionId: context.execution?.id,
          rootExecutionId: context.execution?.collaboration?.rootExecutionId ?? randomUUID(),
          depth: context.depth + 1,
          delegatorBotId: botId,
          path: [...context.path, pattern],
          patternKey: pattern,
        },
        messages: [
          message,
          newMessage(context, botId, "delegation", `Assigned the question to room member ${input.recipientBotId}.`),
        ],
        parentSignal: signal,
      });
      return { message, responseExecutionId: execution.id };
    } catch (error) {
      if (!signal?.aborted) {
        try {
          await recordRejection(context, botId, error instanceof Error ? error.message : "The question could not be assigned.");
        } catch (recordError) {
          console.error("[opencrewbot] Could not persist a question delegation rejection.", recordError);
        }
      }
      throw error;
    }
  }
  try {
    await store.saveCollaborationMessage(message);
  } catch (error) {
    if (input.type === "answer" && responseToMessageId && (await store.hasCollaborationAnswer(responseToMessageId))) {
      throw new InputError("That question already has an answer.");
    }
    throw error;
  }
  return { message };
}

export async function listRoomCollaboration(roomId: string) {
  if (!(await store.getRoom(roomId))) throw new InputError("That room doesn't exist.");
  const [executions, messages] = await Promise.all([
    store.listRoomExecutions(roomId),
    store.listCollaborationMessages(roomId),
  ]);
  return { executions, messages };
}

