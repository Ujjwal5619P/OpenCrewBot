import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

process.env.OPENCREWBOT_DATA_DIR = process.argv[2];
const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...args) {
  const resolved = request.startsWith("@/") ? resolve("src", request.slice(2)) : request;
  return originalResolveFilename.call(this, resolved, parent, ...args);
};
const typescript = require("typescript");
require.extensions[".ts"] = (loadedModule, filename) => {
  const compiled = typescript.transpile(readFileSync(filename, "utf8"), {
    module: typescript.ModuleKind.CommonJS,
    target: typescript.ScriptTarget.ES2022,
    esModuleInterop: true,
  });
  loadedModule._compile(compiled, filename);
};

const core = require(resolve("src/lib/server/approval-core.ts"));
const { toolCategory } = require(resolve("src/lib/server/tools.ts"));
const registeredTools = {
  memory_add: { id: "memory_add" },
  browser_goto: { id: "browser_goto" },
  mcp_server_get_delete_record: { id: "mcp_server_get_delete_record" },
  unknown_tool: { id: "unknown_tool" },
};

process.stdout.write(JSON.stringify({
  ask: [
    core.approvalPolicyForTool("ask", [], "web_search", "read"),
    core.approvalPolicyForTool("ask", [], "memory_add", "edit"),
    core.approvalPolicyForTool("ask", [], "browser_goto", "execute"),
  ],
  controlled: [
    core.approvalPolicyForTool("controlled", ["browser_goto"], "browser_goto", "execute"),
    core.approvalPolicyForTool("controlled", [], "browser_goto", "execute"),
    core.approvalPolicyForTool("controlled", ["mcp_remove_item"], "mcp_remove_item", "mcp"),
  ],
  deceptiveMcp: {
    category: toolCategory("mcp_server_get_delete_record"),
    askPolicy: core.approvalPolicyForTool(
      "ask",
      [],
      "mcp_server_get_delete_record",
      toolCategory("mcp_server_get_delete_record"),
    ),
    controlledPolicy: core.approvalPolicyForTool(
      "controlled",
      ["mcp_server_get_delete_record"],
      "mcp_server_get_delete_record",
      toolCategory("mcp_server_get_delete_record"),
    ),
  },
  full: core.approvalPolicyForTool("full", [], "browser_goto", "execute"),
  codeModeAllowed: Object.keys(
    core.toolsAllowedInCodeMode(
      registeredTools,
      "controlled",
      ["browser_goto", "mcp_server_get_delete_record"],
      toolCategory,
    ),
  ).sort(),
  fullCodeModeAllowed: Object.keys(
    core.toolsAllowedInCodeMode(registeredTools, "full", [], toolCategory),
  ).sort(),
  redacted: core.approvalDetails({
    api_key: "test-key-value",
    nested: { password: "p@ssword" },
    note: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
  }),
  previewRedaction: (() => {
    const args = {
      apiKey: "sk-live-test-credential",
      accessToken: "custom-access-token-value",
      token: "custom-generic-token-value",
      password: "local-password-value",
      clientSecret: "client-secret-value",
      headers: {
        Authorization: "Basic dXNlcjpwYXNzd29yZA==",
        "X-API-Key": "custom-header-key-value",
        "Content-Type": "application/json",
      },
      note: "Authorization: Bearer header-bearer-secret, Proxy-Authorization: Basic proxy-header-secret; mode=read; api_key=inline-key-value; access_token=inline-access-value; token=inline-generic-token; client_secret=inline-client-secret; Keep this context.",
      description: "The token bucket algorithm limits requests.",
    };
    const original = JSON.stringify(args);
    return {
      text: core.approvalDetails(args),
      unchanged: JSON.stringify(args) === original,
    };
  })(),
}));
