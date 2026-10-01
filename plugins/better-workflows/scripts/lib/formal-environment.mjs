// SPDX-License-Identifier: AGPL-3.0-only
import path from "node:path";

/**
 * Build the only environment a formal suite child may observe.  In
 * particular, do not inherit NODE_OPTIONS, proxy settings, caller Git/npm
 * configuration, CODEX_HOME, or an ambient PATH: those values can change the
 * tested code or silently introduce an unpinned executable.
 */
export function createFormalSuiteEnvironment(pathValue, sourceEnv = process.env) {
  if (typeof pathValue !== "string" || !pathValue || pathValue.split(path.delimiter).some((entry) => (
    !entry || !path.isAbsolute(entry) || path.resolve(entry) !== entry
  ))) {
    throw new Error("Formal evaluator fixed PATH is invalid");
  }
  const environment = {
    PATH: pathValue,
    HOME: "/var/empty",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0"
  };
  for (const key of ["TMPDIR", "NPM_CONFIG_CACHE", "SBW_STATE_ROOT"]) {
    const value = sourceEnv?.[key];
    if (typeof value === "string" && value) {
      if (!path.isAbsolute(value) || path.resolve(value) !== value) {
        throw new Error(`Formal evaluator ${key} must be an absolute path`);
      }
      environment[key] = value;
    }
  }
  return Object.freeze(environment);
}

