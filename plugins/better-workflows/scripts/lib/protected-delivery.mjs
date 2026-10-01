// Public Auto delivery route. The policy binding selects the fixed target;
// these checks never grant authority to execute a remote action.
import { assertAutoPolicyBinding } from "./auto-policy-v1.mjs";

function deliveryIdentity(value) {
  if (value === "auto") throw new Error("Public Auto delivery requires its canonical policy binding");
  if (!value || typeof value !== "object" || Array.isArray(value) || value.template !== "auto") {
    return { target: null };
  }
  const binding = assertAutoPolicyBinding(value.autoPolicy);
  return { target: binding.id === "dev-publish-v1" ? "dev" : null };
}

export function protectedDeliveryTarget(contract) {
  return deliveryIdentity(contract).target;
}

export function isProtectedDeliveryTemplate(contract) {
  return protectedDeliveryTarget(contract) !== null;
}

export function targetEvidenceKind(contract) {
  deliveryIdentity(contract);
  return "target-branch-dev";
}

export function assertDeliveryTargetEvidence(evidence, request, repository, revision, contract) {
  const kind = targetEvidenceKind(contract);
  if (!request.requiredEvidence.includes(kind)) return;
  const ref = protectedDeliveryTarget(contract);
  if (!ref) throw new Error("Auto target evidence requires a protected delivery target");
  const exact = evidence.some((item) => (
    item.kind === kind && item.status === "complete" && !item.stale &&
    item.receipt?.payload?.repository === repository &&
    item.receipt?.payload?.ref === ref &&
    (!revision || item.receipt?.payload?.revision === revision)
  ));
  if (!exact) throw new Error(`Action token denied until ${kind} is bound to the selected repository and ${ref} revision`);
}

export function assertProtectedDeliveryRequest(contract, request) {
  const target = protectedDeliveryTarget(contract);
  if (!target) return;
  if (request.action === "remote.sync" && request.resource !== `refs/heads/${target}`) {
    throw new Error(`Auto remote synchronization is restricted to refs/heads/${target}`);
  }
  if (request.action === "git.push") {
    const ref = /^remote:[^:]+:(refs\/heads\/.+)$/.exec(request.resource)?.[1];
    if (["refs/heads/main", "refs/heads/dev"].includes(ref)) {
      throw new Error(`Auto forbids direct pushes to protected ${ref.slice(11)}`);
    }
  }
  if (request.action === "pr.create" && request.scope !== target) {
    throw new Error("Auto PR scope must be dev");
  }
  if (!/^[a-f0-9]{40}$/.test(request.remoteRevision ?? "")) {
    throw new Error("Auto delivery actions require an exact protected base revision");
  }
}
