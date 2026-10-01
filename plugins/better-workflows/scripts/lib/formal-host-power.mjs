const COUNTER_FIELDS = Object.freeze({
  "Sleep Count": "sleepCount",
  "Dark Wake Count": "darkWakeCount",
  "User Wake Count": "userWakeCount"
});
const COUNTER_KEYS = Object.freeze(Object.values(COUNTER_FIELDS));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOT_HEADER = /^\+-o IOPMrootDomain\s+<class IOPMrootDomain,[^>\r\n]*>$/;

function invalid(message) {
  throw new Error(`Formal evaluator host power evidence is invalid: ${message}`);
}

function isCounter(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse the exact three counters reported by macOS `pmset -g stats`. */
export function parseSleepWakeCounters(text) {
  if (typeof text !== "string") invalid("counter output must be text");
  const lines = text.trim().split(/\r?\n/);
  if (lines.length !== COUNTER_KEYS.length) invalid("three counter lines are required");
  const values = new Map();
  for (const line of lines) {
    const match = /^[ \t]*(Sleep Count|Dark Wake Count|User Wake Count)[ \t]*:[ \t]*([0-9]+)[ \t]*$/.exec(line);
    if (!match || values.has(match[1])) invalid("missing, duplicated, or malformed counter");
    const value = Number(match[2]);
    if (!isCounter(value)) invalid("counter must be a safe non-negative integer");
    values.set(match[1], value);
  }
  return Object.fromEntries(Object.entries(COUNTER_FIELDS).map(([label, key]) => {
    if (!values.has(label)) invalid("missing counter");
    return [key, values.get(label)];
  }));
}

/** A missing UUID is valid only in a complete depth-one root-domain snapshot. */
export function parseSleepWakeUuid(text) {
  if (typeof text !== "string" || text.includes("\0")) invalid("invalid ioreg output");
  const lines = text.trim().split(/\r?\n/).map(line => line.trim());
  if (!ROOT_HEADER.test(lines[0] ?? "") || lines[1] !== "{" || lines.at(-1) !== "}" ||
      lines.filter(line => ROOT_HEADER.test(line)).length !== 1) invalid("complete IOPMrootDomain snapshot required");
  const properties = lines.filter(line => line.includes("SleepWakeUUID"));
  if (properties.length === 0) return null;
  if (properties.length !== 1) invalid("duplicated SleepWakeUUID property");
  const match = /^"SleepWakeUUID"[ \t]*=[ \t]*"([^"]+)"$/.exec(properties[0]);
  if (!match || !UUID_PATTERN.test(match[1])) invalid("malformed SleepWakeUUID property");
  return match[1].toUpperCase();
}

function validDarwinObservation(value) {
  if (typeof value.bootIdentity !== "string" || !UUID_PATTERN.test(value.bootIdentity) ||
      value.clamshell !== "open" || value.userActive !== true) return false;
  if (value.sleepWakeUuid !== null && (typeof value.sleepWakeUuid !== "string" || !UUID_PATTERN.test(value.sleepWakeUuid))) return false;
  const counters = value.sleepWakeCounters;
  return isRecord(counters) && Object.keys(counters).length === COUNTER_KEYS.length &&
    COUNTER_KEYS.every(key => Object.hasOwn(counters, key) && isCounter(counters[key]));
}

/**
 * Since-boot counters, not a transient UUID alone, establish power continuity.
 * macOS may retire a UUID after wake. New/replaced UUIDs or any counter change
 * remain fail-closed; missing fields are never converted to zero.
 */
export function formalHostStable(before, after) {
  if (!isRecord(before) || !isRecord(after) || typeof before.platform !== "string" ||
      !/^[a-z][a-z0-9]*$/.test(before.platform) || before.platform !== after.platform) return false;
  if (before.platform !== "darwin") return true;
  if (!validDarwinObservation(before) || !validDarwinObservation(after) ||
      before.bootIdentity.toUpperCase() !== after.bootIdentity.toUpperCase() ||
      !COUNTER_KEYS.every(key => before.sleepWakeCounters[key] === after.sleepWakeCounters[key])) return false;
  const previousUuid = before.sleepWakeUuid?.toUpperCase() ?? null;
  const currentUuid = after.sleepWakeUuid?.toUpperCase() ?? null;
  return previousUuid === currentUuid || (previousUuid !== null && currentUuid === null);
}
