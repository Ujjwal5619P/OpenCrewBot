import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("stores execution history in the versioned SQLite database", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencrewbot-execution-"));
  const fixture = fileURLToPath(new URL("./execution-persistence-fixture.mjs", import.meta.url));
  try {
    const result = spawnSync(process.execPath, [fixture, directory], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: "completed",
      taskOutput: "Verified notes",
      historyId: "history-check",
      historyCount: 4,
      recoveredStatuses: ["outcome_unknown", "failed", "cancelled"],
      claimResults: [false, true],
      schemaVersion: 3,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
