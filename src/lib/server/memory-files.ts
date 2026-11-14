// Individual bot memories live in data/workspaces/<botId>/MEMORY.md. Shared
// project memory is kept separately in data/PROJECT_MEMORY.md.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, lstatSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { DATA_DIR, WORKSPACES_DIR } from "./config";

/** How much of MEMORY.md goes into the prompt. The file itself can be longer. */
export const MEMORY_PROMPT_LIMIT = { lines: 200, bytes: 16 * 1024 };
export const PROJECT_MEMORY_LIMIT = { bytes: 64 * 1024, readBytes: 32 * 1024 };

export function workspaceDir(botId: string): string {
  const dir = join(WORKSPACES_DIR, botId.replace(/[^a-zA-Z0-9_-]/g, ""));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function memoryPath(botId: string): string {
  return join(workspaceDir(botId), "MEMORY.md");
}

export function projectMemoryPath(): string {
  const root = resolve(DATA_DIR);
  const path = resolve(root, "PROJECT_MEMORY.md");
  const rel = relative(root, path);
  if (rel.startsWith(`..${sep}`) || rel === "..") throw new Error("Invalid project memory path.");
  return path;
}

export function readMemory(botId: string): string {
  const path = memoryPath(botId);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function readProjectMemory(): string {
  const path = projectMemoryPath();
  if (!existsSync(path)) return "";
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Project memory must be a regular file.");
  return readFileSync(path, "utf8");
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk|tvly|ak|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(password|passwd|secret|client[_-]?secret|api[_-]?key|token)\s*[:=]\s*\S+/gi,
];

/** Bots sometimes "helpfully" remember a key they saw. They don't get to keep it. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (m) => `«redacted ${m.length} chars»`);
  }
  return out;
}

export function writeMemory(botId: string, content: string): string {
  const path = memoryPath(botId);
  const clean = redactSecrets(content);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, clean, { mode: 0o600 });
  renameSync(tmp, path);
  return clean;
}

export function writeProjectMemory(content: string): string {
  const clean = redactSecrets(content);
  if (Buffer.byteLength(clean, "utf8") > PROJECT_MEMORY_LIMIT.bytes) {
    throw new RangeError(`Project memory must be ${PROJECT_MEMORY_LIMIT.bytes} bytes or less.`);
  }
  const path = projectMemoryPath();
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, clean, { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
  return clean;
}

export function projectMemoryForAgent(): { text: string; truncated: boolean } {
  const full = readProjectMemory();
  const bytes = Buffer.from(full, "utf8");
  if (bytes.length <= PROJECT_MEMORY_LIMIT.readBytes) return { text: full, truncated: false };
  const text = bytes.subarray(0, PROJECT_MEMORY_LIMIT.readBytes).toString("utf8").replace(/\uFFFD$/, "");
  return { text, truncated: true };
}

export function appendProjectMemoryEntry(input: {
  note: string;
  section?: string;
  source: "user" | "project_decision" | { type: "agent"; botId: string };
  confidence: "confirmed" | "unverified";
}): string {
  const note = input.note.trim().replace(/\s+/g, " ");
  if (!note) throw new RangeError("A project memory entry cannot be empty.");
  const section = input.section?.trim().replace(/[\r\n#]+/g, " ").replace(/\s+/g, " ").slice(0, 80);
  if (typeof input.source !== "string" && !/^[a-zA-Z0-9_-]{1,100}$/.test(input.source.botId)) {
    throw new RangeError("Invalid project memory source agent.");
  }
  const source = typeof input.source === "string"
    ? input.source === "project_decision" ? "project decision" : "user"
    : `agent ${input.source.botId}`;
  const today = new Date().toISOString().slice(0, 10);
  const entry = `- ${note} _(source: ${source}; confidence: ${input.confidence}; date: ${today})_`;
  let lines = readProjectMemory().trimEnd().split("\n");
  if (!lines.length || (lines.length === 1 && !lines[0])) lines = ["# Shared project memory"];
  if (section) {
    const heading = `## ${section}`;
    const index = lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());
    if (index >= 0) {
      let end = index + 1;
      while (end < lines.length && !/^##\s/.test(lines[end])) end++;
      lines.splice(end, 0, entry);
    } else {
      lines.push("", heading, entry);
    }
  } else {
    lines.push(entry);
  }
  return writeProjectMemory(`${lines.join("\n")}\n`);
}

export function deleteWorkspace(botId: string): void {
  rmSync(workspaceDir(botId), { recursive: true, force: true });
}

/** The slice of MEMORY.md that loads into the prompt, and whether it was cut. */
export function memoryForPrompt(botId: string): { text: string; truncated: boolean } {
  const full = readMemory(botId);
  let text = full.split("\n").slice(0, MEMORY_PROMPT_LIMIT.lines).join("\n");
  if (Buffer.byteLength(text) > MEMORY_PROMPT_LIMIT.bytes) {
    text = Buffer.from(text).subarray(0, MEMORY_PROMPT_LIMIT.bytes).toString("utf8");
  }
  return { text: text.trim(), truncated: text.length < full.trimEnd().length };
}

export function appendMemory(botId: string, note: string, section?: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const line = `- ${note.trim().replace(/\n+/g, " ")} _(${today})_`;
  let content = readMemory(botId).trimEnd();
  if (section) {
    const heading = `## ${section.trim()}`;
    const idx = content.split("\n").findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
    if (idx >= 0) {
      const lines = content.split("\n");
      let end = idx + 1;
      while (end < lines.length && !lines[end].startsWith("## ")) end++;
      while (end > idx + 1 && lines[end - 1].trim() === "") end--;
      lines.splice(end, 0, line);
      content = lines.join("\n");
    } else {
      content = `${content}${content ? "\n\n" : ""}${heading}\n${line}`;
    }
  } else {
    const afterHeading = /(^|\n)#[^\n]*$/.test(content);
    content = `${content}${content ? (afterHeading ? "\n\n" : "\n") : ""}${line}`;
  }
  return writeMemory(botId, `${content}\n`);
}

export function editMemory(botId: string, find: string, replace: string): { ok: boolean; reason?: string } {
  const content = readMemory(botId);
  const count = content.split(find).length - 1;
  if (!find || count === 0) return { ok: false, reason: "That exact text isn't in MEMORY.md. Read it again and copy the text exactly." };
  if (count > 1) return { ok: false, reason: `That text appears ${count} times. Include more surrounding words so it matches once.` };
  writeMemory(botId, content.replace(find, replace));
  return { ok: true };
}
