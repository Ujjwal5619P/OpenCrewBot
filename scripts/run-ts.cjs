/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  let mapped = request;
  if (mapped.startsWith("@/")) {
    mapped = path.join(SRC, mapped.slice(2));
  }
  const candidates = [mapped, `${mapped}.ts`, `${mapped}.tsx`, path.join(mapped, "index.ts")];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      return c;
    }
  }
  return origResolveFilename.call(this, mapped, parent, isMain, options);
};

for (const ext of [".ts", ".tsx"]) {
  require.extensions[ext] = function (mod, filename) {
    const source = fs.readFileSync(filename, "utf8");
    const { outputText } = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        jsx: ts.JsxEmit.ReactJSX,
        resolveJsonModule: true,
      },
    });
    return mod._compile(outputText, filename);
  };
}

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/run-ts.cjs <script.ts>");
  process.exit(1);
}
require(path.resolve(process.cwd(), target));
