import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("a thrown approval resume is persisted as unknown and never retried", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencrewbot-approval-resume-"));
  const fixture = fileURLToPath(new URL("./approval-resume-fixture.mjs", import.meta.url));
  try {
    const result = spawnSync(process.execPath, [fixture, directory], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      approvalStatus: "outcome_unknown",
      decisionBy: "system:resume-outcome-unknown",
      taskStatus: "outcome_unknown",
      retryCount: 0,
      taskRunCalls: 1,
      resumeCalls: 1,
      possibleSideEffects: 1,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
