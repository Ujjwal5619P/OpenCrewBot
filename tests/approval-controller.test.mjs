import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("Mastra blocks Ask First and unconfigured actions until a decision", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencrewbot-approval-controller-"));
  const fixture = fileURLToPath(new URL("./approval-controller-fixture.mjs", import.meta.url));
  try {
    const result = spawnSync(process.execPath, [fixture, directory], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      askApproved: { requested: true, executed: 1 },
      askRejected: { requested: true, executed: 0 },
      controlledAllowed: { requested: false, executed: 1 },
      controlledUnconfigured: { requested: true, executed: 0 },
      full: { requested: false, executed: 1 },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
