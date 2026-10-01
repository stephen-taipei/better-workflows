// SPDX-License-Identifier: AGPL-3.0-only
// A persisted V3 plan is planning evidence, not command authority. Native
// command execution must recheck the installed public Auto policy and the
// graph's declared write ownership at every authority-creating boundary.
import { assertInstalledAutoPolicyUnchanged, autoPolicyDefinition, autoPolicyDigest, AUTO_POLICY_IDS } from "./auto-policy-v1.mjs";

export class NativeV3AutoExecutionAdmissionError extends Error {
  constructor(message) {
    super(message);
    this.name = "NativeV3AutoExecutionAdmissionError";
    this.code = "EAUTO_V3_EXECUTION_POLICY_HOLD";
    this.status = "HOLD";
  }
}

function hold(message) {
  throw new NativeV3AutoExecutionAdmissionError(message);
}

export function assertNativeV3AutoCommandExecutionAllowed(plan) {
  const binding = plan?.taskContract?.bindings?.template;
  if (binding?.id !== "auto") return null;

  try {
    assertInstalledAutoPolicyUnchanged();
  } catch {
    hold("Installed public Auto policy is unavailable or changed during this process");
  }

  const variants = AUTO_POLICY_IDS.filter((id) =>
    autoPolicyDigest(autoPolicyDefinition(id)) === binding.digest
  );
  if (variants.length !== 1) {
    hold("Persisted Auto template is unknown or differs from the installed canonical policy");
  }
  const variant = variants[0];
  const tasks = plan?.taskContract?.graph?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0 ||
      tasks.some((task) => !Array.isArray(task?.writeOwner?.paths))) {
    hold("Persisted Auto graph has no valid write ownership declaration");
  }
  if (variant === "read-only-v1") {
    if (tasks.some((task) => task.writeOwner.paths.length > 0)) {
      hold("Read-only Auto template conflicts with declared write ownership");
    }
    hold("Read-only Auto V3 plans support planning and verification only; native commands require an enforced read-only execution contract");
  }
  if (variant === "dev-publish-v1") {
    hold("Auto dev-publish V3 commands require an exact integration target bound in TaskContractV3");
  }
  if (tasks.some((task) => task.writeOwner.paths.length === 0)) {
    hold("Command-executable Auto plans require declared write ownership for every task");
  }
  return variant;
}
