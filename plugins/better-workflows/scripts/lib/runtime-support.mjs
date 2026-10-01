const STABLE_NODE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/;

export function supportsV5NodeRuntime(version = process.versions.node) {
  if (typeof version !== "string") return false;
  const match = STABLE_NODE_VERSION.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 14);
}
