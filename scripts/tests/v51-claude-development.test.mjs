import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateV51ClaudeDevelopmentContract } from '../validate-v51-claude-development.mjs';
const root = new URL('../../docs/plans/', import.meta.url);
const [contract, requirements, backlog] = await Promise.all(['v5-1-claude-development-contracts.json','v5-1-requirements.json','v5-1-backlog.json'].map(async name => JSON.parse(await readFile(new URL(name, root),'utf8'))));
test('Root development contract preserves full obligations without granting admission', () => {
  assert.deepEqual(contract.workspace, { bindingStatus: 'PRIVATE_EVIDENCE_REQUIRED', evidenceVisibility: 'private', baseRevision: contract.implementationSource, resourceOrigin: 'host-provided', cleanupDisposition: 'preserve-host-provided' });
  assert.equal(contract.runtimeContract.bounds.depth, 64);
  assert.match(contract.runtimeContract.inventoryDepthSemantics, /root is depth 0/);
  assert.match(contract.runtimeContract.inventoryDepthSemantics, /Depth 64 is allowed/);
  assert.ok(contract.negativeCases.some(value => value.includes('depth 65')));
  assert.deepEqual(validateV51ClaudeDevelopmentContract(contract, requirements, backlog), { id: 'CC-DEV-01', phase: 'local-development', authority: 'none', taskCompletion: 'BLOCKED', runtimeAdmissionVerified: false });
});
for (const [label, mutate] of [
  ['missing traversal-depth bound', c => { delete c.runtimeContract.bounds.depth; }],
  ['different traversal-depth bound', c => { c.runtimeContract.bounds.depth=65; }],
  ['unreviewed traversal-depth semantics', c => { c.runtimeContract.inventoryDepthSemantics='self-declared unlimited'; }],
  ['task-completion promotion', c => { c.taskCompletion='DONE'; }],
  ['effect authority', c => { c.authority='implementation'; }],
  ['release eligibility', c => { c.runtimeContract.effectFields.releaseEligible=true; }],
  ['missing full prerequisite', c => { c.fullCompletionDependencies['CC-01']=[]; }],
  ['unreviewed runtime path', c => { c.writePaths.push('plugins/better-workflows/scripts/lib/core.mjs'); }],
  ['private registration digest reinjection', c => { c.workspace.registrationDigest='f'.repeat(64); }],
  ['private task branch reinjection', c => { c.workspace.taskBranch='codex/fixture-private'; }],
  ['private integration target reinjection', c => { c.workspace.integrationTarget='Solid/fixture-private'; }],
  ['private task ID reinjection', c => { c.workspace.taskId='fixture-private-task'; }],
  ['private worktree path reinjection', c => { c.workspace.worktreePath='/private/tmp/fixture-private'; }],
  ['workspace admission promotion', c => { c.workspace.bindingStatus='VERIFIED'; }],
  ['workspace evidence publication', c => { c.workspace.evidenceVisibility='public'; }],
  ['false upstream completion', c => { c.fullTaskPrerequisiteStatus['B-08']='PASS'; }]
]) test(`rejects ${label}`, () => {
  const c=structuredClone(contract); mutate(c);
  assert.throws(() => validateV51ClaudeDevelopmentContract(c, requirements, backlog), /reviewed development contract drift/);
});
