import { readFile } from "node:fs/promises";
import path from "node:path";
import { digest } from "./canonical.mjs";
import { BUILTIN_ACTION_KINDS } from "./classify.mjs";

export const POLICY_PATH = ".better-workflows/policy.json";
const DECISIONS = new Set(["allow", "ask", "deny"]);
const KIND = /^[a-z][a-z0-9-]{0,63}$/;

const DEFAULT_EVIDENCE = [
  {
    kind: "test",
    argv: [
      ["npm", "test"], ["npm", "run", "test"], ["npm", "t"], ["pnpm", "test"], ["pnpm", "run", "test"],
      ["pnpm", "-r", "test"], ["yarn", "test"], ["bun", "test"], ["node", "--test"], ["vitest"], ["npx", "vitest"],
      ["jest"], ["npx", "jest"], ["nx", "test"], ["nx", "affected", "-t", "test"], ["pnpm", "nx", "test"],
      ["pytest"], ["python", "-m", "pytest"], ["python3", "-m", "pytest"], ["go", "test"], ["cargo", "test"],
      ["mvn", "test"], ["gradle", "test"], ["./gradlew", "test"], ["swift", "test"], ["php", "artisan", "test"],
      ["phpunit"], ["vendor/bin/phpunit"],
    ],
  },
  {
    kind: "lint",
    argv: [["npm", "run", "lint"], ["pnpm", "lint"], ["pnpm", "run", "lint"], ["yarn", "lint"], ["eslint"], ["npx", "eslint"], ["nx", "lint"], ["ruff", "check"]],
  },
  {
    kind: "typecheck",
    argv: [["tsc"], ["npx", "tsc"], ["pnpm", "tsc"], ["npm", "run", "typecheck"], ["pnpm", "typecheck"], ["pnpm", "run", "typecheck"]],
  },
  {
    kind: "build",
    argv: [["npm", "run", "build"], ["pnpm", "build"], ["pnpm", "run", "build"], ["yarn", "build"], ["nx", "build"], ["cargo", "build"], ["go", "build"]],
  },
];

export function defaultPolicy() {
  return normalizePolicy({});
}

function fail(message) {
  throw new Error(`Invalid policy: ${message}`);
}

function plainObject(value, at) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${at} must be an object`);
  return value;
}

function onlyKeys(value, allowed, at) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${at}.${key} is not a known field`);
}

function argvList(value, at) {
  if (!Array.isArray(value) || value.length === 0) fail(`${at} must be a non-empty array of argv prefixes`);
  return value.map((prefix, i) => {
    if (!Array.isArray(prefix) || prefix.length === 0 || !prefix.every((t) => typeof t === "string" && t.length > 0)) {
      fail(`${at}[${i}] must be a non-empty array of strings`);
    }
    return prefix;
  });
}

function decisionRule(value, at) {
  if (typeof value === "string") value = { decision: value };
  value = plainObject(value, at);
  onlyKeys(value, ["decision", "expiresAt", "note"], at);
  if (!DECISIONS.has(value.decision)) fail(`${at}.decision must be allow, ask or deny`);
  if (value.expiresAt !== undefined && Number.isNaN(Date.parse(value.expiresAt))) fail(`${at}.expiresAt must be an ISO date`);
  return { decision: value.decision, expiresAt: value.expiresAt ?? null };
}

export function normalizePolicy(raw) {
  const top = plainObject(raw, "policy");
  onlyKeys(top, ["version", "completion", "evidence", "actions", "opaque"], "policy");
  if (top.version !== undefined && top.version !== 1) fail("version must be 1");

  const completion = plainObject(top.completion, "completion");
  onlyKeys(completion, ["require"], "completion");
  const require = completion.require ?? [];
  if (!Array.isArray(require) || !require.every((k) => typeof k === "string" && KIND.test(k))) fail("completion.require must list evidence kinds");

  const evidence = plainObject(top.evidence, "evidence");
  onlyKeys(evidence, ["kinds"], "evidence");
  const kinds = new Map(DEFAULT_EVIDENCE.map((rule) => [rule.kind, rule.argv]));
  for (const [i, rule] of (evidence.kinds ?? []).entries()) {
    const entry = plainObject(rule, `evidence.kinds[${i}]`);
    onlyKeys(entry, ["kind", "argv"], `evidence.kinds[${i}]`);
    if (!KIND.test(entry.kind ?? "")) fail(`evidence.kinds[${i}].kind is invalid`);
    kinds.set(entry.kind, [...(kinds.get(entry.kind) ?? []), ...argvList(entry.argv, `evidence.kinds[${i}].argv`)]);
  }
  for (const kind of require) if (!kinds.has(kind)) fail(`completion.require names unknown evidence kind ${kind}`);

  const actions = plainObject(top.actions, "actions");
  onlyKeys(actions, ["default", "rules", "custom"], "actions");
  const defaultRule = decisionRule(actions.default ?? "ask", "actions.default");
  const custom = (actions.custom ?? []).map((rule, i) => {
    const entry = plainObject(rule, `actions.custom[${i}]`);
    onlyKeys(entry, ["kind", "argv"], `actions.custom[${i}]`);
    if (!KIND.test(entry.kind ?? "") || BUILTIN_ACTION_KINDS.includes(entry.kind)) fail(`actions.custom[${i}].kind is invalid or reserved`);
    return { kind: entry.kind, argv: argvList(entry.argv, `actions.custom[${i}].argv`) };
  });
  const known = new Set([...BUILTIN_ACTION_KINDS, ...custom.map((rule) => rule.kind)]);
  const rules = {};
  for (const [kind, value] of Object.entries(plainObject(actions.rules, "actions.rules"))) {
    if (!known.has(kind)) fail(`actions.rules.${kind} is not a known action kind`);
    rules[kind] = decisionRule(value, `actions.rules.${kind}`);
  }

  const opaque = decisionRule(top.opaque ?? "ask", "opaque");
  return {
    version: 1,
    completion: { require: [...new Set(require)] },
    evidence: { kinds: [...kinds].map(([kind, argv]) => ({ kind, argv })) },
    actions: { default: defaultRule, rules, custom },
    opaque,
  };
}

// Loads the policy from the working tree. A missing file means defaults; an
// unreadable or invalid file is reported, and callers deny side effects.
export async function loadPolicy(repo) {
  const file = path.join(repo.root, POLICY_PATH);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") return { policy: defaultPolicy(), digest: null, source: "invalid", error: error.message };
    const policy = defaultPolicy();
    return { policy, digest: digest(policy), source: "default", error: null };
  }
  try {
    const policy = normalizePolicy(JSON.parse(text));
    return { policy, digest: digest(policy), source: POLICY_PATH, error: null };
  } catch (error) {
    return { policy: defaultPolicy(), digest: null, source: "invalid", error: error.message };
  }
}

export function ruleFor(policy, kind, now = new Date()) {
  const rule = policy.actions.rules[kind] ?? policy.actions.default;
  if (rule.expiresAt && Date.parse(rule.expiresAt) <= now.getTime()) {
    return { decision: "ask", reason: `authorization for ${kind} expired at ${rule.expiresAt}` };
  }
  return { decision: rule.decision, reason: `policy ${policy.actions.rules[kind] ? `rule for ${kind}` : "default"} is ${rule.decision}` };
}
