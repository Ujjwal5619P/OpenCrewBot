import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("delegates room work, exchanges messages, verifies results, and cancels child work", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencrewbot-collaboration-"));
  const fixture = fileURLToPath(new URL("./collaboration-fixture.mjs", import.meta.url));
  try {
    const result = spawnSync(process.execPath, [fixture, directory], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      executionStatus: "completed",
      parallelPeak: 2,
      dependencyOutputPassed: true,
      dependencyWaited: true,
      approvalRequired: true,
      verificationStatus: "accepted",
      outputShared: true,
      questionAnswered: true,
      invalidAnswerRejected: true,
      repeatedRejected: true,
      activeRepeatedRejected: true,
      persistedRejection: true,
      parentCancellationCancelsChild: true,
      parentCancellationDuringChildPersistencePreventsLaunch: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
