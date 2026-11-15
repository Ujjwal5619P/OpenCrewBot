import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("system prompt requires silent planning and user-facing results only", () => {
  const source = readFileSync(new URL("../src/lib/server/prompt.ts", import.meta.url), "utf8");
  assert.match(source, /do the planning and coordination silently/);
  assert.match(source, /If you cannot perform a step, state the limitation briefly/);
});
