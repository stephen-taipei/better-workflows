import { readFile } from "node:fs/promises";
import path from "node:path";
import { describePolicySource } from "./policy-source.mjs";

// The current bytes are pinned locally; the public source revision is assigned
// only after the clean V5 source export is accepted.
export const ONBOARDING_SPECS = Object.freeze([{
  id: "getting-started", kind: "guide", source: "docs/guide/getting-started.md",
  sha256: "f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6",
  sourceRevision: null,
  sourceStatus: "local-candidate-not-public-source-bound",
  fixedHeadings: ["### Gemini CLI", "### Qwen Code"],
  requiredIdentifiers: ["V5.0","5.0.0-rc.1","V5.1","Node 22/24","Goal","Profiles","Auto","Tier 1","OS Preview","Claude Code","Gemini CLI","Qwen Code","Kimi Code CLI","Kiro","Grok Build","Cursor","GitHub Copilot","Windows","macOS","Linux","CI","PASS"]
}]);

export async function loadOnboardingSources(root) {
  return Promise.all(ONBOARDING_SPECS.map(async (spec) => describePolicySource(
    { ...spec, catalogDirectory: "onboarding" }, await readFile(path.join(root, spec.source), "utf8"))));
}
