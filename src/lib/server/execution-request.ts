export function executionRequestBody(value: unknown): { instruction: unknown } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return { instruction: (value as Record<string, unknown>).instruction };
}
