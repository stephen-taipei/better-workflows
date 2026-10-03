import { readFile } from "node:fs/promises";
import path from "node:path";
import { describePolicySource } from "./policy-source.mjs";

// The current bytes are pinned locally; the public source revision is assigned
// only after the clean V5 source export is accepted.
export const ONBOARDING_SPECS = Object.freeze([{
  id: "getting-started", kind: "guide", source: "docs/guide/getting-started.md",
  sha256: "ebc32288ff5e0273341400f754e50ee8e9a30174d21fc479e5736bb9fee758e5",
  sourceRevision: null,
  sourceStatus: "local-candidate-not-public-source-bound",
  fixedHeadings: ["### Gemini CLI", "### Qwen Code"],
  requiredIdentifiers: ["V5.0","5.0.0-rc.1","V5.1","Node 22/24","Goal","Profiles","Auto","Tier 1","OS Preview","Claude Code","Gemini CLI","Qwen Code","Kimi Code CLI","Kiro","Grok Build","Cursor","GitHub Copilot","Windows","macOS","Linux","CI","PASS"]
}]);

export async function loadOnboardingSources(root) {
  return Promise.all(ONBOARDING_SPECS.map(async (spec) => describePolicySource(
    { ...spec, catalogDirectory: "onboarding" }, await readFile(path.join(root, spec.source), "utf8"))));
}
