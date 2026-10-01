import { readFile } from "node:fs/promises";
import path from "node:path";
import { describePolicySource } from "./policy-source.mjs";
import { parseWorkflowDiagram } from "./workflow-diagram.mjs";

export const WORKFLOW_SPECS = Object.freeze([{
  id: "workflows", kind: "guide", source: "docs/guide/workflows.md",
  sha256: "2acaf671415fc972265bcc5c4f20484c1a6cbea2dd1e6aa3fb22f54943786bb0",
  sourceRevision: null,
  upstreamSourceSha256: "35d3af3362512a9c6797bd61dce07cbdffb0b1f42793c2442de6ca23e09c72fd",
  sourceStatus: "local-candidate-not-public-source-bound",
  editorialCorrection: "V5.0 public guidance contains only the Auto entry and common paths. Historical template and mode flow instructions are outside this guide. The previous d456e143 source is provenance only; this edited candidate is not release or native-speaker acceptance.",
  requiredIdentifiers: ["Auto", "HOLD"]
}]);

export async function loadWorkflowSources(root) {
  return Promise.all(WORKFLOW_SPECS.map(async (spec) => {
    const source = describePolicySource({ ...spec, catalogDirectory: "workflows" }, await readFile(path.join(root, spec.source), "utf8"));
    const texts = [];
    const blocks = source.blocks.map((block) => {
      if (block.type === "code" && block.source.startsWith("```mermaid\n")) {
        const labels = parseWorkflowDiagram(block.source);
        const indices = labels.map((label) => texts.push(label) - 1);
        return { ...block, type: "workflow-diagram", indices };
      }
      if (block.type === "text") return { ...block, index: texts.push(block.text) - 1 };
      return block;
    });
    if (blocks.filter((block) => block.type === "workflow-diagram").length !== 1) throw new Error("Missing source workflow diagram");
    return { ...source, blocks, texts };
  }));
}
