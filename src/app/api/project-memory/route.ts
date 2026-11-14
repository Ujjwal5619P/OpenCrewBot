import { handle, body } from "@/lib/server/http";
import { InputError } from "@/lib/server/errors";
import { publish } from "@/lib/server/bus";
import {
  appendProjectMemoryEntry,
  PROJECT_MEMORY_LIMIT,
  projectMemoryPath,
  readProjectMemory,
  writeProjectMemory,
} from "@/lib/server/memory-files";
import { authorizedProjectMemoryBots, setAuthorizedProjectMemoryBots } from "@/lib/server/project-memory";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET() {
  return handle(async () => ({
    content: readProjectMemory(),
    path: projectMemoryPath(),
    authorizedBotIds: await authorizedProjectMemoryBots(),
    limit: PROJECT_MEMORY_LIMIT,
  }));
}

export async function PUT(request: Request) {
  return handle(async () => {
    const value = await body<unknown>(request);
    if (!isObject(value) || typeof value.content !== "string") {
      throw new InputError("Expected { content: string }.");
    }
    if (Buffer.byteLength(value.content, "utf8") > PROJECT_MEMORY_LIMIT.bytes) {
      throw new InputError(`Project memory must be ${PROJECT_MEMORY_LIMIT.bytes} bytes or less.`);
    }
    const content = writeProjectMemory(value.content);
    publish({ type: "project-memory-changed" });
    return { content };
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const value = await body<unknown>(request);
    if (!isObject(value)) throw new InputError("Expected a project memory entry.");
    const note = value.note;
    const section = value.section;
    const source = value.source;
    const confidence = value.confidence;
    if (typeof note !== "string" || !note.trim() || note.length > 4_000) {
      throw new InputError("The note must contain 1-4,000 characters.");
    }
    if (section !== undefined && (typeof section !== "string" || section.length > 80)) {
      throw new InputError("The section must be 80 characters or less.");
    }
    if (source !== "user" && source !== "project_decision") {
      throw new InputError("Choose user or project-decision provenance.");
    }
    if (confidence !== "confirmed" && confidence !== "unverified") {
      throw new InputError("Choose confirmed or unverified confidence.");
    }
    try {
      const content = appendProjectMemoryEntry({
        note,
        section,
        source,
        confidence,
      });
      publish({ type: "project-memory-changed" });
      return { content };
    } catch (error) {
      if (error instanceof RangeError) throw new InputError(error.message);
      throw error;
    }
  });
}

export async function PATCH(request: Request) {
  return handle(async () => {
    const value = await body<unknown>(request);
    if (!isObject(value) || !Array.isArray(value.expectedAuthorizedBotIds)) {
      throw new InputError("Expected { authorizedBotIds: string[], expectedAuthorizedBotIds: string[] }.");
    }
    const authorizedBotIds = await setAuthorizedProjectMemoryBots(
      value.authorizedBotIds,
      value.expectedAuthorizedBotIds,
    );
    if (!authorizedBotIds) {
      return Response.json(
        { error: "Project memory access changed elsewhere. Reload the access list before saving." },
        { status: 409 },
      );
    }
    publish({ type: "project-memory-changed" });
    return { authorizedBotIds };
  });
}
