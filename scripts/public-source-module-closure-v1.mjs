// SPDX-License-Identifier: AGPL-3.0-only
// Advisory dependency preflight for an exact W3 source selection. This module
// does not authenticate source bytes, approve distribution rights, or grant
// publication authority. Run it with --experimental-vm-modules on Node 22/24.

import { createHash } from "node:crypto";
import { isBuiltin } from "node:module";
import path from "node:path";
import vm from "node:vm";

const SHA1 = /^[a-f0-9]{40}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)[^\\\u0000-\u001f\u007f]+$/u;
const SOURCE_EXTENSIONS = new Set([".mjs", ".js"]);
const UNSCANNED_RUNTIME_EXTENSIONS = new Set([".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"]);
const SAFE_NODE_MODULE_IMPORT = /^import \{ (?:isBuiltin|syncBuiltinESMExports) \} from ["']node:module["'];?(?:\r?\n|$)/u;
const DECODER = new TextDecoder("utf-8", { fatal: true });

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function fail(message) {
  throw new Error(`public module closure: ${message}`);
}

function ownData(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor?.enumerable || !("value" in descriptor)) fail(`${key} must be an own data field`);
  return descriptor.value;
}

function safePath(value) {
  return typeof value === "string" && value.length <= 4096 && SAFE_PATH.test(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." &&
      part.toLowerCase() !== ".git" && Buffer.byteLength(part, "utf8") <= 255);
}

function moduleRequests(source, file, unresolved) {
  if (!vm.SourceTextModule) {
    unresolved.push({ from: file, reference: null, reason: "module-parser-unavailable" });
    return [];
  }
  try {
    const parsed = new vm.SourceTextModule(source, { identifier: file });
    if (Array.isArray(parsed.moduleRequests)) {
      return parsed.moduleRequests.map((request) => {
        if (typeof request?.specifier !== "string" || !request.specifier ||
            (request.phase !== undefined && request.phase !== "evaluation")) {
          unresolved.push({ from: file, reference: request?.specifier ?? null, reason: "unknown-module-request" });
          return null;
        }
        return { reference: request.specifier, kind: "static-import" };
      }).filter(Boolean);
    }
    if (Array.isArray(parsed.dependencySpecifiers)) {
      return parsed.dependencySpecifiers.map((reference) => ({ reference, kind: "static-import" }));
    }
    unresolved.push({ from: file, reference: null, reason: "module-requests-unavailable" });
  } catch {
    unresolved.push({ from: file, reference: null, reason: "module-parse-failed" });
  }
  return [];
}

// Lexical scan for dynamic import and import.meta.resolve. Comments, strings,
// and template raw text are skipped; template expressions are scanned as code.
// A computed or escaped specifier stays unresolved rather than being guessed.
function runtimeRequests(source, file, unresolved, safeNodeModuleImports = []) {
  const requests = [];
  const frames = [{ kind: "code", braces: null }];
  let cursor = 0;
  const identifier = (char) => char !== undefined && /[A-Za-z0-9_$]/u.test(char);
  const skipQuoted = (quote) => {
    cursor += 1;
    while (cursor < source.length) {
      if (source[cursor] === "\\") { cursor += 2; continue; }
      if (source[cursor++] === quote) return true;
    }
    return false;
  };
  const skipTrivia = (start) => {
    let position = start;
    while (position < source.length) {
      if (/\s/u.test(source[position])) { position += 1; continue; }
      if (source.startsWith("//", position)) {
        position = source.indexOf("\n", position + 2);
        if (position < 0) return source.length;
        continue;
      }
      if (source.startsWith("/*", position)) {
        const end = source.indexOf("*/", position + 2);
        if (end < 0) return source.length;
        position = end + 2;
        continue;
      }
      break;
    }
    return position;
  };
  while (cursor < source.length) {
    const frame = frames.at(-1);
    const char = source[cursor];
    const next = source[cursor + 1];
    if (frame.kind === "template") {
      if (char === "\\") { cursor += 2; continue; }
      if (char === "`") { frames.pop(); cursor += 1; continue; }
      if (char === "$" && next === "{") { frames.push({ kind: "code", braces: 0 }); cursor += 2; continue; }
      cursor += 1;
      continue;
    }
    if (frame.braces !== null && char === "}") {
      if (frame.braces === 0) frames.pop();
      else frame.braces -= 1;
      cursor += 1;
      continue;
    }
    if (frame.braces !== null && char === "{") { frame.braces += 1; cursor += 1; continue; }
    if (char === "'" || char === '"') {
      if (!skipQuoted(char)) unresolved.push({ from: file, reference: null, reason: "unterminated-string" });
      continue;
    }
    if (char === "`") { frames.push({ kind: "template" }); cursor += 1; continue; }
    if (char === "/" && next === "/") {
      cursor = source.indexOf("\n", cursor + 2);
      if (cursor < 0) break;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", cursor + 2);
      if (end < 0) { unresolved.push({ from: file, reference: null, reason: "unterminated-comment" }); break; }
      cursor = end + 2;
      continue;
    }
    if (char === "/" && /(?:^|[=(:,\[!&|?{};])$|\b(?:return|throw|case)$|=>$/.test(
      source.slice(Math.max(0, cursor - 32), cursor).trimEnd()
    )) {
      // Skip a regex literal only at an unambiguous expression start. This
      // prevents quotes or a dynamic import call in regex source from posing as code.
      let position = cursor + 1;
      let inClass = false;
      while (position < source.length) {
        const current = source[position];
        if (current === "\\") { position += 2; continue; }
        if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) break;
        else if (current === "\n") break;
        position += 1;
      }
      if (source[position] === "/") {
        cursor = position + 1;
        while (/[A-Za-z]/u.test(source[cursor] ?? "")) cursor += 1;
        continue;
      }
    }
    if (source.startsWith("require", cursor) && !identifier(source[cursor - 1]) && !identifier(source[cursor + 7]) &&
        source[skipTrivia(cursor + 7)] === "(") {
      unresolved.push({ from: file, reference: null, reason: "commonjs-require-needs-review" });
      cursor += 7;
      continue;
    }
    if (source.startsWith("createRequire", cursor) && !identifier(source[cursor - 1]) &&
        !identifier(source[cursor + 13])) {
      unresolved.push({ from: file, reference: null, reason: "node-create-require-needs-review" });
      cursor += 13;
      continue;
    }
    if (source.startsWith("getBuiltinModule", cursor) && !identifier(source[cursor - 1]) &&
        !identifier(source[cursor + 16])) {
      unresolved.push({ from: file, reference: null, reason: "node-builtin-module-loader-needs-review" });
      cursor += 16;
      continue;
    }
    if (source.startsWith("import", cursor) && !identifier(source[cursor - 1]) && !identifier(source[cursor + 6])) {
      if (SAFE_NODE_MODULE_IMPORT.test(source.slice(cursor))) safeNodeModuleImports.push(cursor);
      const after = skipTrivia(cursor + 6);
      if (source[after] === "(") {
        const argument = skipTrivia(after + 1);
        const quote = source[argument];
        if (quote === "'" || quote === '"') {
          const end = source.indexOf(quote, argument + 1);
          const close = end < 0 ? -1 : skipTrivia(end + 1);
          const value = end < 0 ? "" : source.slice(argument + 1, end);
          if (end > argument + 1 && !value.includes("\\") && source[close] === ")") {
            requests.push({ reference: value, kind: "dynamic-import" });
          } else unresolved.push({ from: file, reference: null, reason: "computed-dynamic-import" });
        } else unresolved.push({ from: file, reference: null, reason: "computed-dynamic-import" });
      } else if (source.slice(after, after + 5) === ".meta") {
        const resolveAt = skipTrivia(after + 5);
        if (source.slice(resolveAt, resolveAt + 8) === ".resolve") {
          unresolved.push({ from: file, reference: null, reason: "runtime-module-resolution" });
        }
      }
      cursor += 6;
      continue;
    }
    cursor += 1;
  }
  if (frames.length !== 1) unresolved.push({ from: file, reference: null, reason: "unterminated-template" });
  return requests;
}

// Resolve only an exact package-root self-reference from selected manifest
// bytes. Subpath maps, wildcard exports and additional runtime conditions stay
// unresolved. Equal import/default targets avoid conditional ordering guesses.
function packageSelfReference(from, reference, selected, sourcePaths, edges, excludedReachability, unresolved) {
  if (from.split("/").some((part) => part.toLowerCase() === "node_modules")) {
    unresolved.push({ from, reference, reason: "node-modules-self-reference-needs-review" });
    return null;
  }
  let directory = path.posix.dirname(from);
  let manifestPath;
  while (true) {
    const candidate = directory === "." ? "package.json" : `${directory}/package.json`;
    if (sourcePaths.has(candidate)) { manifestPath = candidate; break; }
    if (directory === ".") return null;
    directory = path.posix.dirname(directory);
  }
  const reject = (reason) => {
    unresolved.push({ from, reference, reason });
    return null;
  };
  if (!selected.has(manifestPath)) return reject("package-self-reference-manifest-not-selected");
  let manifest;
  try { manifest = JSON.parse(DECODER.decode(selected.get(manifestPath).bytes)); }
  catch { return reject("invalid-package-self-reference-manifest"); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      typeof manifest.name !== "string" ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(manifest.name) ||
      manifest.name !== reference) return reject("unresolved-bare-or-external-module");
  edges.push({ from, to: manifestPath, reference, kind: "package-self-reference-manifest" });
  let definition = manifest.exports;
  if (definition && typeof definition === "object" && !Array.isArray(definition) &&
      Object.hasOwn(definition, ".")) {
    if (Object.keys(definition).length !== 1) return reject("package-self-reference-exports-shape-unscanned");
    definition = definition["."];
  }
  let target = definition;
  let typesTarget = null;
  let hasTypesTarget = false;
  if (definition && typeof definition === "object" && !Array.isArray(definition)) {
    const keys = Object.keys(definition);
    if (keys.length === 0 || keys.some((key) => !["types", "import", "default"].includes(key))) {
      return reject("package-self-reference-exports-shape-unscanned");
    }
    if (Object.hasOwn(definition, "import") && Object.hasOwn(definition, "default") &&
        definition.import !== definition.default) return reject("package-self-reference-conditional-targets-differ");
    target = Object.hasOwn(definition, "import") ? definition.import : definition.default;
    if (Object.hasOwn(definition, "types")) {
      hasTypesTarget = true;
      typesTarget = definition.types;
    }
  }
  const resolveTarget = (value) => {
    if (typeof value !== "string" || !value.startsWith("./") || /[%?#*]/u.test(value) ||
        !safePath(value.slice(2)) ||
        value.slice(2).split("/").some((part) => part.toLowerCase() === "node_modules")) return null;
    const resolved = path.posix.join(directory, value.slice(2));
    return safePath(resolved) ? resolved : null;
  };
  const resolved = resolveTarget(target);
  if (!resolved) return reject("package-self-reference-export-target-invalid");
  if (hasTypesTarget) {
    const typePath = resolveTarget(typesTarget);
    if (!typePath || !typePath.endsWith(".d.ts")) return reject("package-self-reference-type-target-invalid");
    const edge = { from, to: typePath, reference, kind: "package-self-reference-types" };
    if (selected.has(typePath)) edges.push(edge);
    else if (sourcePaths.has(typePath)) excludedReachability.push(edge);
    else return reject("package-self-reference-type-target-missing");
  }
  return resolved;
}

function resolveRequest(from, request, selected, sourcePaths, edges, excludedReachability, unresolved) {
  const { reference, kind } = request;
  if (typeof reference !== "string" || !reference) {
    unresolved.push({ from, reference: null, reason: "invalid-specifier" });
    return;
  }
  if (isBuiltin(reference)) return;
  let selfReferenceTarget = null;
  if (!reference.startsWith("./") && !reference.startsWith("../")) {
    const before = unresolved.length;
    selfReferenceTarget = packageSelfReference(from, reference, selected, sourcePaths, edges, excludedReachability, unresolved);
    if (!selfReferenceTarget) {
      if (unresolved.length === before) unresolved.push({ from, reference, reason: "unresolved-bare-or-external-module" });
      return;
    }
  }
  // Node resolves ESM specifiers as URLs. Comparing a percent-encoded
  // specifier with literal Git paths could conceal an excluded target.
  if (reference.includes("%")) {
    unresolved.push({ from, reference, reason: "percent-encoded-module-path" });
    return;
  }
  const pathname = reference.split(/[?#]/u, 1)[0];
  const target = selfReferenceTarget ?? path.posix.normalize(path.posix.join(path.posix.dirname(from), pathname));
  if (!safePath(target) || target.startsWith("../")) {
    unresolved.push({ from, reference, reason: "module-path-escape" });
  } else if (selected.has(target)) {
    edges.push({ from, to: target, reference, kind });
  } else if (sourcePaths.has(target)) {
    excludedReachability.push({ from, to: target, reference, kind });
  } else {
    unresolved.push({ from, reference, reason: "missing-module-target" });
  }
}

/**
 * Inspect the ESM slice of a proposed public projection. `entries` must cover
 * the full source tree; their bytes and decisions are caller supplied. Only a
 * separate W3 producer/verifier can authenticate those bytes and decisions.
 */
export function analyzePublicModuleClosureV1({ sourceSha, sourceTreeOid, entries, derivedOutputs = [] } = {}) {
  if (!SHA1.test(sourceSha ?? "") || !SHA1.test(sourceTreeOid ?? "") ||
      !Array.isArray(entries) || entries.length < 1 || entries.length > 4096 ||
      !Array.isArray(derivedOutputs) || derivedOutputs.length > 3) fail("source identity or bounds are invalid");
  const source = new Map();
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("entry is invalid");
    const file = ownData(entry, "path");
    const decision = ownData(entry, "decision");
    const bytes = ownData(entry, "bytes");
    if (!safePath(file) || source.has(file) || !["include", "exclude"].includes(decision) ||
        !(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) || bytes.length > 16 * 1024 * 1024) {
      fail("entry path, decision, or bytes are invalid");
    }
    totalBytes += bytes.length;
    if (totalBytes > 128 * 1024 * 1024) fail("source byte bound exceeded");
    source.set(file, { decision, bytes: Buffer.from(bytes) });
  }
  const selected = new Map([...source].filter(([, entry]) => entry.decision === "include"));
  for (const output of derivedOutputs) {
    if (!output || typeof output !== "object" || Array.isArray(output)) fail("derived output is invalid");
    const file = ownData(output, "path");
    const sourcePath = ownData(output, "sourcePath");
    if (!safePath(file) || !safePath(sourcePath) || selected.has(file) ||
        !source.has(sourcePath) || source.get(sourcePath).decision !== "exclude") {
      fail("derived output has an invalid source or collision");
    }
    selected.set(file, source.get(sourcePath));
  }
  const selectionDigest = digest([...source].map(([file, entry]) => [
    file, entry.decision, createHash("sha256").update(entry.bytes).digest("hex")
  ]).sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]))));
  const edges = [];
  const unresolved = [];
  const excludedReachability = [];
  for (const [file, entry] of selected) {
    const extension = path.posix.extname(file);
    if (UNSCANNED_RUNTIME_EXTENSIONS.has(extension) && !file.endsWith(".d.ts")) {
      unresolved.push({ from: file, reference: null, reason: "runtime-source-extension-unscanned" });
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(extension)) continue;
    let text;
    try { text = DECODER.decode(entry.bytes); }
    catch { unresolved.push({ from: file, reference: null, reason: "invalid-utf8-module" }); continue; }
    const safeNodeModuleImports = [];
    const requests = [...moduleRequests(text, file, unresolved), ...runtimeRequests(text, file, unresolved, safeNodeModuleImports)];
    const nodeModuleRequests = requests.filter(({ reference }) => reference === "node:module" || reference === "module");
    const safeNodeModuleImport = nodeModuleRequests.length === 1 &&
      nodeModuleRequests[0].kind === "static-import" &&
      nodeModuleRequests[0].reference === "node:module" && safeNodeModuleImports.length === 1;
    for (const request of requests) {
      if ((request.reference === "node:module" || request.reference === "module") && !safeNodeModuleImport) {
        unresolved.push({ from: file, reference: request.reference, reason: "node-module-loader-needs-review" });
        continue;
      }
      resolveRequest(file, request, selected, source, edges, excludedReachability, unresolved);
    }
  }
  const order = (left, right) => Buffer.compare(Buffer.from(JSON.stringify(left)), Buffer.from(JSON.stringify(right)));
  edges.sort(order);
  unresolved.sort(order);
  excludedReachability.sort(order);
  const body = {
    schemaVersion: 1,
    kind: "W3PublicModuleClosurePreflightV1",
    authority: "none",
    sourceSha,
    sourceTreeOid,
    selectionDigest,
    coverage: "included-js-and-esm-module-dependencies-in-caller-supplied-set-only",
    sourceCompleteness: "CALLER_ASSERTED_UNVERIFIED",
    edges,
    unresolved,
    excludedReachability,
    status: unresolved.length || excludedReachability.length ? "HOLD" : "NO_RECORDED_GAPS_IN_SUPPLIED_SET",
    publicationAdmission: "HOLD"
  };
  return Object.freeze({ ...body, receiptDigest: digest(body) });
}
