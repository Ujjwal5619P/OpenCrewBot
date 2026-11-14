import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

process.env.OPENCREWBOT_DATA_DIR = process.argv[2];
const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;
Module._resolveFilename = function (request, parent, ...args) {
  const resolved = request.startsWith("@/") ? resolve("src", request.slice(2)) : request;
  return originalResolveFilename.call(this, resolved, parent, ...args);
};
Module._load = function (request, parent, ...args) {
  if (request === "./service" && parent?.filename.endsWith(`${resolve("src/lib/server/http.ts")}`)) {
    return { boot: async () => {} };
  }
  if (request === "@/lib/server/runtime") {
    return { respondToApproval: async () => { throw new Error("private database detail"); } };
  }
  return originalLoad.call(this, request, parent, ...args);
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

const route = require(resolve("src/app/api/conversations/[id]/approval/route.ts"));
Module._load = originalLoad;

async function post(value) {
  return route.POST(new Request("http://localhost/api/conversations/dm%3Atest/approval", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof value === "string" ? value : JSON.stringify(value),
  }), { params: Promise.resolve({ id: "dm%3Atest" }) });
}

const malformed = await Promise.all([post("null"), post("[]"), post({ botId: "x", toolCallId: "y", approve: "true" })]);
const internalError = await post({ botId: "x", toolCallId: "y", approve: true });
process.stdout.write(JSON.stringify({
  malformedStatuses: malformed.map((response) => response.status),
  internalStatus: internalError.status,
  internalMessage: (await internalError.json()).error,
}));
