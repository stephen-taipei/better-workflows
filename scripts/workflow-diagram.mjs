// A deliberately closed compiler for the source-owned six-choice Auto route map.
// Translators supply seven visible labels, never Mermaid IDs or executable syntax.
const destinations = Object.freeze([
  ["B", "auto"], ["C", "auto"], ["D", "auto"],
  ["E", "HOLD"], ["F", "auto"], ["G", "HOLD"]
]);
const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export function validateWorkflowLabels(labels) {
  if (!Array.isArray(labels) || labels.length !== 7 || labels.some((label) =>
    typeof label !== "string" || !label.trim() || /[\r\n"\\<>|{}\[\]`]|[\u202a-\u202e\u2066-\u2069]/u.test(label))) {
    throw new Error("Invalid localized workflow diagram labels");
  }
}

export function workflowDiagramMarkdown(labels) {
  validateWorkflowLabels(labels);
  return ["```mermaid", "flowchart TD", `  A{${JSON.stringify(labels[0])}}`,
    ...destinations.map(([node, target], index) => `  A -->|${JSON.stringify(labels[index + 1])}| ${node}[${JSON.stringify(target)}]`),
    "```"].join("\n");
}

export function parseWorkflowDiagram(source) {
  const lines = source.split("\n");
  const question = lines[2]?.match(/^  A\{"([^"\\]*)"\}$/)?.[1];
  const labels = [question, ...destinations.map(([node, target], index) => {
    const match = lines[index + 3]?.match(/^  A -->\|"([^"\\]*)"\| ([B-G])\["([^"\\]*)"\]$/);
    if (!match || match[2] !== node || match[3] !== target) throw new Error("Workflow diagram topology drift");
    return match[1];
  })];
  if (workflowDiagramMarkdown(labels) !== source) throw new Error("Workflow diagram source round-trip drift");
  return labels;
}

export function workflowDiagramHtml(labels) {
  validateWorkflowLabels(labels);
  // Native HTML is responsive, searchable, keyboard-independent and screen-reader
  // readable; no third-party diagram runtime or locale text is loaded remotely.
  return `<figure class="workflow-map" aria-labelledby="workflow-map-question"><figcaption id="workflow-map-question">${escapeHtml(labels[0])}</figcaption><ul>${destinations.map(([, target], index) =>
    `<li><span>${escapeHtml(labels[index + 1])}</span><code dir="ltr">${escapeHtml(target)}</code></li>`).join("")}</ul></figure>`;
}
