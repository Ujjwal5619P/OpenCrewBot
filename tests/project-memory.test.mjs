import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("keeps private memory isolated and persists authorized, attributed project memory", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencrewbot-project-memory-"));
  const fixture = fileURLToPath(new URL("./project-memory-fixture.mjs", import.meta.url));
  const run = (mode) => {
    const result = spawnSync(process.execPath, [fixture, directory, mode], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };

  try {
    assert.deepEqual(run("write"), {
      privateIsolation: true,
      legacyMemoryPreserved: true,
      authorizedRead: true,
      deniedRead: true,
      deniedWrite: true,
      unauthorizedToolsNotRegistered: true,
      unauthorizedWriteLeftFileUnchanged: true,
      markdownEditPreservedProvenance: true,
      secretsRedacted: true,
      markdownApiEditAndSave: true,
      userEntryProvenance: true,
      invalidGrantRejected: true,
      staleAccessSaveRejected: true,
      revocationRotatesThread: true,
      commonSecretFormatsRedacted: true,
      readToolCategorizedReadOnly: true,
      writeToolCategorizedEdit: true,
      fixedProjectPath: true,
    });
    assert.deepEqual(run("verify"), {
      sharedMarkdownPersisted: true,
      authorizationPersisted: true,
      accessGenerationPersisted: true,
      privateFilesPersistedIndependently: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
