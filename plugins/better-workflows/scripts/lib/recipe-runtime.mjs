import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const hostProcess = process;

function disableGlobal(name) {
  try {
    Object.defineProperty(globalThis, name, {
      configurable: false,
      enumerable: false,
      get() {
        throw new Error(`${name} is unavailable in a workspace recipe`);
      },
      set() {
        throw new Error(`${name} is unavailable in a workspace recipe`);
      }
    });
  } catch {
    // The parent validator also rejects these capabilities lexically.
  }
}

for (const name of [
  "fetch",
  "WebSocket",
  "EventSource",
  "BroadcastChannel",
  "Worker",
  "SharedWorker",
  "process"
]) {
  disableGlobal(name);
}

async function readRequest() {
  const chunks = [];
  for await (const chunk of hostProcess.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) throw new Error("Recipe runtime request is empty");
  return JSON.parse(raw);
}

const request = await readRequest();
const timeoutController = new AbortController();
const keepAlive = setInterval(() => {}, 1000);
const timer = setTimeout(
  () => timeoutController.abort(new Error("Recipe timeout")),
  request.timeoutMs
);
timer.unref();

try {
  const source = await readFile(request.entryPath, "utf8");
  const sourceUrl = `${pathToFileURL(request.entryPath).href}?digest=${request.scriptDigest}`;
  const module = await import(sourceUrl);
  if (typeof module.default !== "function") {
    throw new Error("run.mjs must export a default function");
  }
  const context = Object.freeze({
    input: Object.freeze(request.input),
    workspacePath: request.workspacePath,
    artifactStagingPath: request.artifactStagingPath,
    signal: timeoutController.signal,
    stderr(message) {
      hostProcess.stderr.write(`${String(message)}\n`);
    }
  });
  const result = await module.default(context);
  hostProcess.stdout.write(`${JSON.stringify({ ok: true, result, sourceBytes: Buffer.byteLength(source) })}\n`);
} catch (error) {
  hostProcess.stdout.write(
    `${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })}\n`
  );
  hostProcess.exitCode = 1;
} finally {
  clearTimeout(timer);
  clearInterval(keepAlive);
}
