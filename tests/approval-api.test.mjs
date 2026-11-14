import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("approval API rejects malformed bodies and hides internal errors", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencrewbot-approval-api-"));
  const fixture = fileURLToPath(new URL("./approval-api-fixture.mjs", import.meta.url));
  try {
    const result = spawnSync(process.execPath, [fixture, directory], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      malformedStatuses: [400, 400, 400],
      internalStatus: 500,
      internalMessage: "Something went wrong. Please try again.",
    });
    assert.doesNotMatch(result.stdout, /private database detail/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
