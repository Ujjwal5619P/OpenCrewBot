import type { ApprovalMode } from "@/lib/shared/types";
import { redactSecrets } from "./memory-files";

export type ApprovalCategory = "read" | "edit" | "execute" | "mcp" | "other";
export type ApprovalPolicy = "allow" | "ask";
export const APPROVAL_REQUEST_TTL_MS = 30 * 60 * 1000;

const SENSITIVE_ACTION = /(?:^|_)(send|post|create|update|delete|remove|transfer|purchase|pay|invite|share|submit|deploy|merge|commit|publish|upload|click|type|fill|press|execute)(?:_|$)/i;
const SECRET_ASSIGNMENT =
  /\b((?:proxy[-_]?authorization|authorization|x[-_]?api[-_]?key)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;]+)|\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|password|passwd|token)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&]+)/gi;

function isSecretField(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return /(?:^|_)(?:api_key|access_token|refresh_token|id_token|auth_token|bearer_token|authorization|proxy_authorization|x_api_key|cookie|secret|password|passwd|credential|private_key|client_secret|token)$/.test(
    normalized,
  );
}

function redactApprovalText(value: string): string {
  let output = "";
  let cursor = 0;
  for (const match of value.matchAll(SECRET_ASSIGNMENT)) {
    const index = match.index ?? 0;
    output += redactSecrets(value.slice(cursor, index));
    output += `${match[1] ?? match[2]}[redacted]`;
    cursor = index + match[0].length;
  }
  return output + redactSecrets(value.slice(cursor));
}

export function isSensitiveApprovalAction(toolName: string, category: ApprovalCategory): boolean {
  if (toolName.startsWith("COMPOSIO_") && /MULTI_EXECUTE/.test(toolName)) return true;
  if (category === "mcp") return true;
  return SENSITIVE_ACTION.test(toolName);
}

export function approvalPolicyForTool(
  mode: ApprovalMode,
  allowedActions: string[],
  toolName: string,
  category: ApprovalCategory,
): ApprovalPolicy {
  if (mode === "full") return "allow";
  if (category === "read") return "allow";
  if (mode === "ask" && category === "edit") return "allow";
  if (
    mode === "controlled" &&
    allowedActions.includes(toolName) &&
    !isSensitiveApprovalAction(toolName, category)
  ) {
    return "allow";
  }
  return "ask";
}

export function toolsAllowedInCodeMode<T>(
  tools: Record<string, T>,
  mode: ApprovalMode,
  allowedActions: string[],
  categoryOf: (toolName: string) => ApprovalCategory | null,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(tools).filter(([toolName]) =>
      approvalPolicyForTool(mode, allowedActions, toolName, categoryOf(toolName) ?? "other") === "allow",
    ),
  );
}

function redactArguments(value: unknown, key = ""): unknown {
  if (isSecretField(key)) return "[redacted]";
  if (typeof value === "string") return redactApprovalText(value);
  if (Array.isArray(value)) return value.map((item) => redactArguments(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        redactArguments(child, childKey),
      ]),
    );
  }
  return value;
}

export function approvalDetails(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(redactArguments(value)) ?? "null";
  } catch {
    serialized = '"[details unavailable]"';
  }
  return serialized.length > 2_000 ? `${serialized.slice(0, 2_000)}…` : serialized;
}

export function approvalActionLabel(label: string, detail?: string): string {
  const safeLabel = redactApprovalText(label);
  return detail ? `${safeLabel}: ${redactApprovalText(detail)}` : safeLabel;
}

export function safeApprovalText(value: string): string {
  return redactApprovalText(value);
}

export function executionTaskForConversation(conversationId: string): { executionId?: string; taskId?: string } {
  const match = /^execution:([^:]+):task:(.+)$/.exec(conversationId);
  return match ? { executionId: match[1], taskId: match[2] } : {};
}
