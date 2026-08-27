import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, open } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pluginRoot } from "./core.mjs";
import {
  ReplayError,
  assertReplayRunId,
  buildReplaySnapshot,
  listReplayRuns
} from "./replay.mjs";

export const REPLAY_HOST = "127.0.0.1";
export const REPLAY_PUBLIC_HOST = "localhost";
export const REPLAY_PORT = 9300;
export const REPLAY_SESSION_COOKIE = "sbw_replay_session";
export const REPLAY_BOOTSTRAP_TTL_MS = 30_000;
export const REPLAY_UI_FILE_LIMIT_BYTES = 4 * 1024 * 1024;

const UI_ROOT = path.join(pluginRoot(), "ui", "evidence-cinema");
const PUBLIC_ASSETS = new Map([
  ["cinema.css", "text/css; charset=utf-8"],
  ["renderer.js", "text/javascript; charset=utf-8"],
  ["cast-lineup.webp", "image/webp"],
  ["character-root.webp", "image/webp"],
  ["character-pixel.webp", "image/webp"],
  ["character-ledger.webp", "image/webp"],
  ["character-vera.webp", "image/webp"],
  ["character-sentinel.webp", "image/webp"],
  ["character-echo.webp", "image/webp"],
  ["scene-01-goal.webp", "image/webp"],
  ["scene-02-binding.webp", "image/webp"],
  ["scene-03-evidence.webp", "image/webp"],
  ["scene-04-verifier.webp", "image/webp"],
  ["scene-05-ledger.webp", "image/webp"],
  ["scene-06-review.webp", "image/webp"],
  ["scene-07-gate.webp", "image/webp"],
  ["scene-08-reconcile.webp", "image/webp"]
]);

const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
});

export class ReplayServerError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = "ReplayServerError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function requestError(code, statusCode) {
  return new ReplayError(code, "Replay request could not be completed", statusCode);
}

function secureHeaders(extra = {}) {
  return { ...SECURITY_HEADERS, ...extra };
}

function writeResponse(response, statusCode, headers, body, headOnly = false) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""));
  response.writeHead(statusCode, secureHeaders({
    "Content-Length": String(buffer.length),
    ...headers
  }));
  response.end(headOnly ? undefined : buffer);
}

function writeJson(response, statusCode, value, headOnly = false) {
  writeResponse(
    response,
    statusCode,
    { "Content-Type": "application/json; charset=utf-8" },
    `${JSON.stringify(value)}\n`,
    headOnly
  );
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""));
  const rightBuffer = Buffer.from(String(right ?? ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cookieValue(request, name) {
  const header = request.headers.cookie;
  if (typeof header !== "string") return null;
  for (const pair of header.split(";")) {
    const equal = pair.indexOf("=");
    if (equal < 1) continue;
    if (pair.slice(0, equal).trim() === name) return pair.slice(equal + 1).trim();
  }
  return null;
}

function cleanPathForRun(runId) {
  return runId ? `/runs/${runId}` : "/";
}

function assertRequestBoundary(request, expectedHost, expectedOrigin) {
  if (request.headers.host !== expectedHost) throw requestError("REPLAY_HOST_REJECTED", 421);
  const remote = request.socket.remoteAddress;
  if (!["127.0.0.1", "::ffff:127.0.0.1"].includes(String(remote))) {
    throw requestError("REPLAY_REMOTE_REJECTED", 403);
  }
  if (request.headers["sec-fetch-site"] === "cross-site") {
    throw requestError("REPLAY_CROSS_SITE_REJECTED", 403);
  }
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== expectedOrigin) {
    throw requestError("REPLAY_ORIGIN_REJECTED", 403);
  }
  const target = String(request.url ?? "");
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\0")) {
    throw requestError("REPLAY_REQUEST_TARGET_REJECTED", 400);
  }
  return target;
}

async function readPublicFile(target, contentType) {
  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    throw requestError("REPLAY_ASSET_UNAVAILABLE", 404);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > REPLAY_UI_FILE_LIMIT_BYTES) {
      throw requestError("REPLAY_ASSET_UNAVAILABLE", 404);
    }
    const body = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < body.length) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, offset);
    const after = await handle.stat();
    if (extraBytes !== 0 || after.size !== info.size) {
      throw requestError("REPLAY_ASSET_UNAVAILABLE", 404);
    }
    return { body: body.subarray(0, offset), contentType };
  } finally {
    await handle.close();
  }
}

async function publicAsset(name) {
  const contentType = PUBLIC_ASSETS.get(name);
  if (!contentType) throw requestError("REPLAY_ASSET_NOT_ALLOWED", 404);
  return readPublicFile(path.join(UI_ROOT, name.endsWith(".webp") ? "assets" : "", name), contentType);
}

async function runtimeHtml() {
  return readPublicFile(path.join(UI_ROOT, "runtime.html"), "text/html; charset=utf-8");
}

export function platformOpenCommand(url, platform = process.platform) {
  if (platform === "darwin") return { executable: "/usr/bin/open", args: [url] };
  if (platform === "win32") {
    return {
      executable: "C:\\Windows\\System32\\rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url]
    };
  }
  return { executable: "/usr/bin/xdg-open", args: [url] };
}

export async function openReplayBrowser(url, options = {}) {
  const command = platformOpenCommand(url, options.platform);
  await access(command.executable);
  const child = (options.spawn ?? spawn)(command.executable, command.args, {
    detached: true,
    shell: false,
    stdio: "ignore"
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return { executable: command.executable, args: command.args };
}

export async function startReplayServer(options = {}) {
  if (typeof options.stateRoot !== "string" || !path.isAbsolute(options.stateRoot)) {
    throw new ReplayServerError("REPLAY_STATE_ROOT_INVALID", "Replay state root must be an absolute path");
  }
  const stateRoot = path.resolve(options.stateRoot);
  const requestedRunId = options.runId ? assertReplayRunId(options.runId) : null;
  const host = options.host ?? REPLAY_HOST;
  if (host !== REPLAY_HOST) {
    throw new ReplayServerError("REPLAY_HOST_INVALID", "Replay server must bind to 127.0.0.1");
  }
  const requestedPort = options.port ?? REPLAY_PORT;
  const bootstrapTtlMs = options.bootstrapTtlMs ?? REPLAY_BOOTSTRAP_TTL_MS;
  let bootstrapToken = randomBytes(32).toString("base64url");
  const bootstrapExpiresAt = Date.now() + bootstrapTtlMs;
  const sessionToken = randomBytes(32).toString("base64url");
  const sockets = new Set();
  let boundPort = requestedPort;

  const server = http.createServer(async (request, response) => {
    const headOnly = request.method === "HEAD";
    try {
      const expectedHost = `${REPLAY_PUBLIC_HOST}:${boundPort}`;
      const expectedOrigin = `http://${expectedHost}`;
      const target = assertRequestBoundary(request, expectedHost, expectedOrigin);
      if (!['GET', 'HEAD'].includes(String(request.method))) throw requestError("REPLAY_METHOD_NOT_ALLOWED", 405);
      const url = new URL(target, expectedOrigin);
      if (url.search) throw requestError("REPLAY_QUERY_REJECTED", 400);

      if (url.pathname.startsWith("/bootstrap/")) {
        if (request.method !== "GET") throw requestError("REPLAY_METHOD_NOT_ALLOWED", 405);
        const supplied = url.pathname.slice("/bootstrap/".length);
        if (!bootstrapToken || Date.now() > bootstrapExpiresAt || !constantTimeEqual(supplied, bootstrapToken)) {
          throw requestError("REPLAY_BOOTSTRAP_REJECTED", 401);
        }
        bootstrapToken = null;
        response.writeHead(303, secureHeaders({
          "Content-Length": "0",
          "Location": cleanPathForRun(requestedRunId),
          "Set-Cookie": `${REPLAY_SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`
        }));
        response.end();
        return;
      }

      if (!constantTimeEqual(cookieValue(request, REPLAY_SESSION_COOKIE), sessionToken)) {
        throw requestError("REPLAY_SESSION_REQUIRED", 401);
      }

      if (url.pathname === "/api/v1/runs") {
        const value = await listReplayRuns(stateRoot);
        writeJson(response, 200, value, headOnly);
        return;
      }
      const replayApi = /^\/api\/v1\/runs\/(sbw-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12})\/replay$/.exec(url.pathname);
      if (replayApi) {
        const value = await buildReplaySnapshot(stateRoot, replayApi[1]);
        writeJson(response, 200, value, headOnly);
        return;
      }
      const asset = /^\/assets\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(url.pathname);
      if (asset) {
        const value = await publicAsset(asset[1]);
        writeResponse(response, 200, { "Content-Type": value.contentType }, value.body, headOnly);
        return;
      }
      if (url.pathname === "/" || url.pathname === "/demo" || /^\/runs\/sbw-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/.test(url.pathname)) {
        const value = await runtimeHtml();
        writeResponse(response, 200, { "Content-Type": value.contentType }, value.body, headOnly);
        return;
      }
      throw requestError("REPLAY_ROUTE_NOT_FOUND", 404);
    } catch (error) {
      const statusCode = error instanceof ReplayError ? error.statusCode : 500;
      const code = error instanceof ReplayError ? error.code : "REPLAY_INTERNAL_ERROR";
      writeJson(response, statusCode, { ok: false, error: code }, headOnly);
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") {
        reject(new ReplayServerError("REPLAY_PORT_IN_USE", "localhost:9300 is already in use", 2));
      } else {
        reject(new ReplayServerError("REPLAY_LISTEN_FAILED", "Replay server could not bind to localhost:9300", 1));
      }
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port: requestedPort, exclusive: true });
  });
  const address = server.address();
  boundPort = typeof address === "object" && address ? address.port : requestedPort;
  const origin = `http://${REPLAY_PUBLIC_HOST}:${boundPort}`;
  const cleanUrl = `${origin}${cleanPathForRun(requestedRunId)}`;
  const bootstrapUrl = `${origin}/bootstrap/${bootstrapToken}`;

  const close = async () => {
    bootstrapToken = null;
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, 2_000);
      timeout.unref();
      server.close(() => {
        clearTimeout(timeout);
        resolve();
      });
      server.closeIdleConnections?.();
    });
  };

  return {
    server,
    stateRoot,
    runId: requestedRunId,
    host,
    port: boundPort,
    origin,
    cleanUrl,
    bootstrapUrl,
    close
  };
}
