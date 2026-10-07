import { CONNECTORS_LOCALES } from "./website-locales.mjs";
import { overlayLocales } from "./locale-overlay.mjs";

// Translation of the new V4 navigation headings only. Normative body prose
// remains canonical English under the reference guides' explicit partial policy.
const SOURCE_HEADINGS = [
  "### Host-neutral core and host adapters",
  "### Risk-adaptive Auto and workspace ownership",
  "### Transition policy and pilot retirement",
  "## Task worktree isolation",
  "## Auto fast path check isolation",
  "## Hosts and workspaces"
];

const LABELS = overlayLocales({
  en: ["Host-neutral core and host adapters", "Risk-adaptive Auto and workspace ownership", "Transition policy and pilot retirement", "Task worktree isolation", "Auto fast path check isolation", "Hosts and workspaces"],
  "zh-Hant-TW": ["主機中立核心與主機適配器", "風險自適應 Auto 與工作區所有權", "過渡政策與試行退場", "任務工作樹隔離", "Auto fast path 檢查隔離", "主機與工作區"],
}, "reference-v4-labels", CONNECTORS_LOCALES);

export function v4ReferenceHeadingEntries(code) {
  if (!CONNECTORS_LOCALES.includes(code) || !LABELS[code] || LABELS[code].length !== SOURCE_HEADINGS.length) {
    throw new Error(`V4 reference heading locale is incomplete: ${code}`);
  }
  return SOURCE_HEADINGS.map((heading, index) => [heading, LABELS[code][index]]);
}
