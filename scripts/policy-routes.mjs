import { CONNECTORS_LOCALES, DEFAULT_LOCALE } from "./website-locales.mjs";

export const POLICY_ROUTES = Object.freeze({ "CONTRIBUTING.md": "contributing", "SECURITY.md": "security", "GOVERNANCE.md": "governance", "CODE_OF_CONDUCT.md": "conduct", "THIRD_PARTY_NOTICES.md": "notices" });
export const GUIDE_ROUTES = Object.freeze({ "docs/guide/readme-quality.md": "readme-quality", "docs/guide/getting-started.md": "getting-started", "docs/guide/workflows.md": "workflows", "docs/guide/architecture.md": "architecture", "docs/guide/security.md": "security-guide", "docs/guide/cli-reference.md": "cli-reference", "docs/html/use-cases/assets/color-system.md": "color-system" });
export const PUBLIC_TEXT_ROUTES = Object.freeze({ ...POLICY_ROUTES, ...GUIDE_ROUTES });

export function publicTextPath(code, id) {
  if (!CONNECTORS_LOCALES.includes(code)) throw new Error(`Unsupported public-text locale: ${code}`);
  if (!Object.values(PUBLIC_TEXT_ROUTES).includes(id)) throw new Error(`Unsupported public text: ${id}`);
  const section = Object.values(GUIDE_ROUTES).includes(id) ? "guides" : "policies";
  return `${code === DEFAULT_LOCALE ? "" : `/${code}`}/${section}/${id}/`;
}

export function publicTextMarkdownPath(code, id) {
  publicTextPath(code, id);
  return `docs/locales/${code}/${id}.md`;
}

export function policyPath(code, id) {
  if (!CONNECTORS_LOCALES.includes(code)) throw new Error(`Unsupported policy locale: ${code}`);
  if (!Object.values(POLICY_ROUTES).includes(id)) throw new Error(`Unsupported policy: ${id}`);
  return publicTextPath(code, id);
}

export function policyMarkdownPath(code, id) {
  policyPath(code, id);
  return `docs/locales/${code}/${id}.md`;
}
