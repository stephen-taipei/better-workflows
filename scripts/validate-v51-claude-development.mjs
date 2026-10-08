import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateV51Catalog } from './validate-v51-plan.mjs';
const REVIEWED_CONTRACT_DIGEST = 'aa2688bb3cafde958e164d1079030ae31a3efbff7f268bfdd426ab713b53390c';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const claudeDevelopmentContractDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function validateV51ClaudeDevelopmentContract(contract, requirements, backlog) {
  validateV51Catalog(requirements, backlog);
  assert.equal(claudeDevelopmentContractDigest(contract), REVIEWED_CONTRACT_DIGEST, 'reviewed development contract drift');
  assert.equal(contract.kind, 'V51RootDevelopmentContractV1');
  assert.equal(contract.phase, 'local-development');
  assert.equal(contract.authority, 'none');
  assert.equal(contract.taskCompletion, 'BLOCKED');
  assert.equal(contract.originalCatalogBase, backlog.developmentBase);
  assert.equal(contract.writeOwner, 'root');
  assert.equal(contract.workspace.resourceOrigin, 'host-provided');
  assert.equal(contract.workspace.cleanupDisposition, 'preserve-host-provided');
  assert.deepEqual(Object.keys(contract.workspace).sort(), ['baseRevision', 'bindingStatus', 'cleanupDisposition', 'evidenceVisibility', 'resourceOrigin'], 'public workspace projection fields');
  assert.equal(contract.workspace.bindingStatus, 'PRIVATE_EVIDENCE_REQUIRED');
  assert.equal(contract.workspace.evidenceVisibility, 'private');
  assert.equal(contract.workspace.baseRevision, contract.implementationSource);
  // Actual lease identity/validity is external admission evidence, never established by this projection.
  assert.deepEqual(contract.fullCompletionDependencies, Object.fromEntries(backlog.tasks.filter(task => /^CC-0[1-7]$/.test(task.code)).map(task => [task.code, task.dependencies])));
  for (const task of backlog.tasks.filter(task => /^CC-0[1-7]$/.test(task.code))) assert.equal(task.state, 'BLOCKED');
  for (const task of ['B-08', 'W0-01', 'W0-06']) assert.equal(contract.fullTaskPrerequisiteStatus[task], 'NOT_ACCEPTED');
  assert.deepEqual(contract.runtimeContract.effectFields, { authority: 'observation-only', releaseEligible: false, provenanceVerified: false });
  assert.equal(new Set(contract.writePaths).size, contract.writePaths.length);
  assert.ok(contract.writePaths.includes(contract.runtimeContract.module));
  for (const path of contract.writePaths) assert.ok(!path.startsWith('/') && !path.split('/').includes('..'), 'noncanonical development path');
  return { id: contract.id, phase: contract.phase, authority: 'none', taskCompletion: 'BLOCKED', runtimeAdmissionVerified: false };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('../docs/plans/', import.meta.url);
  const [contract, requirements, backlog] = await Promise.all(['v5-1-claude-development-contracts.json', 'v5-1-requirements.json', 'v5-1-backlog.json'].map(async name => JSON.parse(await readFile(new URL(name, root), 'utf8'))));
  console.log(JSON.stringify(validateV51ClaudeDevelopmentContract(contract, requirements, backlog), null, 2));
}
