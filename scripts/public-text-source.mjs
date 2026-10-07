import { readFile } from "node:fs/promises";
import path from "node:path";
import { POLICY_SPECS, describePolicySource } from "./policy-source.mjs";
import { ONBOARDING_SPECS } from "./onboarding-source.mjs";
import { WORKFLOW_SPECS } from "./workflow-source.mjs";
import { ARCHITECTURE_SPEC, loadArchitectureSource } from "./architecture-source.mjs";
import { SECURITY_GUIDE_SPEC, loadSecurityGuideSource } from "./security-source.mjs";
import { CLI_REFERENCE_SPEC, loadCliReferenceSource } from "./cli-reference-source.mjs";

// Keep new canonical documents separately pinned: an overview is never a body translation.
export const ADDITIONAL_TEXT_SPECS = Object.freeze([
  { id: "conduct", kind: "policy", source: "CODE_OF_CONDUCT.md", sha256: "746c393957e3f25a833a5671f16a8ac53497b7cc3d1b6c5ac7f8eb63be36ee40" },
  { id: "notices", kind: "policy", source: "THIRD_PARTY_NOTICES.md", sha256: "98858e4e8811be07d02b2a4a35035cdda639b53be270d8bf0b342fcf8bcea48e", fixedReferenceList: true },
  { id: "readme-quality", kind: "guide", source: "docs/guide/readme-quality.md", sha256: "16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b" },
  { id: "color-system", kind: "guide", source: "docs/html/use-cases/assets/color-system.md", sha256: "edf32956ca99c7a6e6ffb1e978a1db935a54cfe2cd9cb22c06735b1078cd5120", fixedTableHeader: "| Role | Light | Dark | Use |" }
]);
export const GUIDE_TEXT_SPECS = Object.freeze([ARCHITECTURE_SPEC, SECURITY_GUIDE_SPEC, CLI_REFERENCE_SPEC]);
export const PUBLIC_TEXT_SPECS = Object.freeze([...POLICY_SPECS, ...ADDITIONAL_TEXT_SPECS, ...GUIDE_TEXT_SPECS, ...ONBOARDING_SPECS, ...WORKFLOW_SPECS]);

export async function loadAdditionalTextSources(root) {
  return Promise.all(ADDITIONAL_TEXT_SPECS.map(async (spec) => describePolicySource(
    { ...spec, catalogDirectory: "public-docs" }, await readFile(path.join(root, spec.source), "utf8"))));
}

export async function loadGuideTextSources(root) {
  const architecture = await loadArchitectureSource(root);
  const security = await loadSecurityGuideSource(root);
  const cliReference = await loadCliReferenceSource(root);
  return [architecture, security, cliReference];
}
