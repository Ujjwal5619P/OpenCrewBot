import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("approval modes and code-mode tool access enforce the configured policy", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencrewbot-approval-policy-"));
  const fixture = fileURLToPath(new URL("./approval-policy-fixture.mjs", import.meta.url));
  try {
    const result = spawnSync(process.execPath, [fixture, directory], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const value = JSON.parse(result.stdout);
    assert.deepEqual(value.ask, ["allow", "allow", "ask"]);
    assert.deepEqual(value.controlled, ["allow", "ask", "ask"]);
    assert.deepEqual(value.deceptiveMcp, {
      category: "mcp",
      askPolicy: "ask",
      controlledPolicy: "ask",
    });
    assert.equal(value.full, "allow");
    assert.deepEqual(value.codeModeAllowed, ["browser_goto"]);
    assert.deepEqual(value.fullCodeModeAllowed, ["browser_goto", "mcp_server_get_delete_record", "memory_add", "unknown_tool"]);
    assert.doesNotMatch(value.redacted, /test-key-value|p@ssword|eyJhbGci/);
    assert.match(value.redacted, /\[redacted\]/);
    assert.equal(value.previewRedaction.unchanged, true);
    assert.doesNotMatch(
      value.previewRedaction.text,
      /sk-live-test-credential|custom-access-token-value|custom-generic-token-value|local-password-value|client-secret-value|dXNlcjpwYXNzd29yZA==|custom-header-key-value|header-bearer-secret|proxy-header-secret|inline-key-value|inline-access-value|inline-generic-token|inline-client-secret/,
    );
    assert.match(value.previewRedaction.text, /"Content-Type":"application\/json"/);
    assert.match(value.previewRedaction.text, /mode=read/);
    assert.match(value.previewRedaction.text, /Keep this context/);
    assert.match(value.previewRedaction.text, /token bucket algorithm limits requests/);
    assert.match(value.previewRedaction.text, /"accessToken":"\[redacted\]"/);
    assert.match(value.previewRedaction.text, /Authorization: \[redacted\]/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
