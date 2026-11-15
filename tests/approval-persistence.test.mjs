import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("approval decisions are atomic, expire safely, and persist across server restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencrewbot-approval-persistence-"));
  const fixture = fileURLToPath(new URL("./approval-persistence-fixture.mjs", import.meta.url));
  try {
    const write = spawnSync(process.execPath, [fixture, directory], { encoding: "utf8" });
    assert.equal(write.status, 0, write.stderr || write.stdout);
    assert.deepEqual(JSON.parse(write.stdout), {
      firstDecision: "approved",
      duplicateReason: "already_decided",
      rejected: "rejected",
      resumeFailure: "failed",
      unknownOutcome: "outcome_unknown",
      cancelledReason: "cancelled",
      expiredReason: "expired",
    });

    const verify = spawnSync(process.execPath, [fixture, directory, "verify"], { encoding: "utf8" });
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
    assert.deepEqual(JSON.parse(verify.stdout), {
      statuses: {
        approved: "approved",
        rejected: "rejected",
        failed: "failed",
        unknown: "outcome_unknown",
        cancelled: "cancelled",
        expired: "expired",
        interrupted: "cancelled",
      },
      schemaVersion: 7,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
