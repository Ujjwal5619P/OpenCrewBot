import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { nextScheduledOccurrence, zonedLocalDateTimeToUtc } from "../src/lib/server/schedule-core.ts";

test("calculates timezone-aware daily and weekly recurrences across DST", () => {
  const after = new Date("2025-03-08T23:00:00.000Z");
  assert.equal(
    nextScheduledOccurrence(
      { recurrence: "daily", timeZone: "America/New_York", localTime: "09:00", weekdays: [] },
      after,
    )?.toISOString(),
    "2025-03-09T13:00:00.000Z",
  );
  assert.equal(
    nextScheduledOccurrence(
      { recurrence: "weekly", timeZone: "America/New_York", localTime: "09:30", weekdays: [1] },
      new Date("2025-03-09T16:00:00.000Z"),
    )?.toISOString(),
    "2025-03-10T13:30:00.000Z",
  );
  assert.equal(zonedLocalDateTimeToUtc("2025-03-09T02:30", "America/New_York"), null);
  assert.equal(
    zonedLocalDateTimeToUtc("2025-11-02T01:30", "America/New_York")?.toISOString(),
    "2025-11-02T05:30:00.000Z",
  );
});

test("persists schedules, prevents duplicate runs, recovers claims, and reports skipped or failed occurrences", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencrewbot-scheduled-"));
  const fixture = fileURLToPath(new URL("./scheduled-workflows-fixture.mjs", import.meta.url));
  try {
    const result = spawnSync(process.execPath, [fixture, directory], { encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      simulatedPlanning: true,
      persistence: true,
      inputValidation: true,
      duplicateLaunches: 1,
      manualScheduleLink: true,
      overlapRejected: true,
      pauseResume: true,
      missedRunSkipped: true,
      failedRunRecorded: true,
      invalidWorkflowRejected: true,
      recoveredClaim: true,
      staleRecoverySkipped: true,
      recoveryMetadataRestored: true,
      newerMetadataPreserved: true,
      perWorkflowHistory: true,
      approvalRequired: true,
      deleteWorks: true,
      schemaVersion: 6,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
