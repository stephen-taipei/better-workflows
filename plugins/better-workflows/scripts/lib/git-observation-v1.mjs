// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

const SAFE_COMPONENT = /^[A-Za-z0-9._-]+$/;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex");
}

export function isExactGitAbsence(result, { absentCodes = [1] } = {}) {
  return result?.ok === false && absentCodes.includes(result.code) && result.signal == null &&
    !result.timedOut && !result.outputExceeded;
}

export async function readRawLocalConfigValues(runGit, key, {
  maxBuffer,
  timeoutMs,
  label = "Git configuration"
} = {}) {
  const result = await runGit(["config", "--null", "--local", "--no-includes", "--get-all", key], {
    allowFailure: true,
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
  if (!result.ok) {
    if (isExactGitAbsence(result)) return [];
    const detail = String(result.stderr || result.code || "unknown failure").trim();
    const error = new Error(`${label} could not read raw local ${key}: ${detail}`);
    error.code = result.code;
    error.signal = result.signal;
    throw error;
  }
  if (typeof result.stdout !== "string") throw new Error(`${label} returned non-text ${key} values`);
  if (!result.stdout.endsWith("\0")) throw new Error(`${label} returned unterminated raw local ${key} values`);
  const values = result.stdout.slice(0, -1).split("\0");
  if (values.some((value) => /[\r\n]/.test(value))) {
    throw new Error(`${label} contains an invalid raw local ${key} value`);
  }
  return values;
}

export function canonicalGovernedGithubRepository(remote) {
  if (typeof remote !== "string" || remote !== remote.trim() || !remote) return null;
  let parsed;
  try {
    parsed = new URL(remote);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.port && parsed.port !== "443")) return null;
  const pathname = parsed.pathname.endsWith("/") ? parsed.pathname.slice(0, -1) : parsed.pathname;
  const parts = pathname.split("/");
  if (parts.length !== 3 || parts[0] !== "" || !SAFE_COMPONENT.test(parts[1])) return null;
  const repository = parts[2].endsWith(".git") ? parts[2].slice(0, -4) : parts[2];
  if (!SAFE_COMPONENT.test(repository)) return null;
  return `github.com/${parts[1]}/${repository}`;
}

export async function resolveGovernedGithubRepository(runGit, options = {}) {
  const fetchUrls = await readRawLocalConfigValues(runGit, "remote.origin.url", {
    ...options,
    label: options.label ?? "Governed repository binding"
  });
  const pushUrls = await readRawLocalConfigValues(runGit, "remote.origin.pushurl", {
    ...options,
    label: options.label ?? "Governed repository binding"
  });
  if (fetchUrls.length !== 1 || pushUrls.length > 1) {
    throw new Error("Governed repository requires one raw local origin and at most one raw push URL");
  }
  const repository = canonicalGovernedGithubRepository(fetchUrls[0]);
  const pushRepository = pushUrls.length === 0
    ? repository
    : canonicalGovernedGithubRepository(pushUrls[0]);
  if (!repository || pushRepository !== repository) {
    throw new Error("Governed repository requires matching credential-free HTTPS GitHub fetch and push repositories");
  }
  const remoteBinding = { fetchUrls, pushUrls };
  return {
    repository,
    fetchUrls,
    pushUrls,
    remoteBindingDigest: sha256(canonical(remoteBinding))
  };
}
