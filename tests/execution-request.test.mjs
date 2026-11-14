import assert from "node:assert/strict";
import { test } from "node:test";
import { executionRequestBody } from "../src/lib/server/execution-request.ts";
import { internalErrorResponse } from "../src/lib/server/errors.ts";

test("accepts only non-null, non-array objects as execution request bodies", () => {
  assert.deepEqual(executionRequestBody({ instruction: "prepare a report" }), { instruction: "prepare a report" });
  for (const value of [null, undefined, [], ["instruction"], "text", 42, true]) {
    assert.equal(executionRequestBody(value), null);
  }
});

test("internal API errors return a safe generic response", async () => {
  const response = internalErrorResponse();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Something went wrong. Please try again." });
});
