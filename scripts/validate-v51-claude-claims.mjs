// Planning-only structural checks. No receipt here establishes trusted identity,
// signing authority, dispatch readiness, host qualification or release authority.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateV51Catalog } from './validate-v51-plan.mjs';

const PLAN_DIGEST = 'f73420f95a1b81656295c41b1e52e50b10a4acd2587a582d5da0c2b6280e241c';
const PHASES = ['development', 'qualification', 'release'];
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const claudeClaimDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function exact(value, keys, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has unknown or missing fields`);
}
function text(value, label) { assert.ok(typeof value === 'string' && value.trim(), `${label} missing`); }
function hash(value, label) { assert.ok(typeof value === 'string' && SHA256.test(value), `${label} invalid`); }

// Release evidence producers must be reachable through full-task dependencies.
// This structural relationship does not authenticate the resulting receipts.
export function validateClaudeReleaseDependencies(plan, backlog) {
  const producers = { 'codex-conformance': 'B-04b', 'gemini-conformance': 'B-04c', 'qwen-conformance': 'B-04d' };
  const claim = plan.claims.find(claim => claim.task === 'CC-07');
  const tasks = new Map(backlog.tasks.map(task => [task.code, task]));
  const reachable = new Set();
  function visit(code) {
    if (reachable.has(code)) return;
    reachable.add(code);
    for (const dependency of tasks.get(code)?.dependencies ?? []) visit(dependency);
  }
  visit('CC-07');
  for (const [evidence, producer] of Object.entries(producers)) {
    assert.ok(claim?.release.requiredEvidence.includes(evidence), `CC-07 release evidence missing: ${evidence}`);
    assert.ok(tasks.has(producer) && reachable.has(producer), `CC-07 release producer dependency missing: ${producer}`);
  }
}

export function validateV51ClaudeClaimPlan(plan, requirements, backlog) {
  validateClaudeReleaseDependencies(plan, backlog);
  validateV51Catalog(requirements, backlog);
  assert.equal(claudeClaimDigest(plan), PLAN_DIGEST, 'reviewed Claude claim plan drift');
  assert.equal(plan.developmentBase, backlog.developmentBase, 'claim development base drift');
  assert.equal(plan.developmentBase, requirements.developmentBase, 'requirement base drift');
  assert.equal(plan.sourceDigest, requirements.sourceDigest, 'claim source digest drift');
  assert.equal(requirements.leafTrackingTotal, plan.trackedLeaves, 'tracked obligation drift');
  assert.equal(requirements.gaEligibleTotal, plan.gaObligations, 'GA obligation drift');
  for (const claim of plan.claims) {
    const task = backlog.tasks.find(task => task.code === claim.task);
    assert.ok(task, `claim task missing: ${claim.task}`);
    assert.deepEqual(task.requirements, [claim.requirement], 'claim requirement mismatch');
    const row = requirements.rows.find(row => row.id === claim.requirement);
    assert.equal(row?.dependencies, claim.requirementDependencies, 'claim requirement dependency drift');
    assert.deepEqual(task.dependencies, claim.completionDependencies, 'CC completion dependency drift');
    // R10 adopts no dispatch packet or runtime authority. A future READY change
    // needs its own independently reviewed planning revision, not this checker.
    assert.equal(task.state, 'BLOCKED', 'R10 preparation cannot establish READY');
    for (const phase of PHASES) assert.equal(claim[phase].mayCompleteTask, false);
  }
  return Object.freeze({ claims: plan.claims.length, authority: 'none', taskCompletion: 'BLOCKED' });
}

export function validateV51ClaudeClaimObservation(plan, requirements, backlog, observed, expected) {
  validateV51ClaudeClaimPlan(plan, requirements, backlog);
  exact(expected, ['task', 'phase', 'sourceRevision', 'policyDigest'], 'expected binding');
  assert.ok(PHASES.includes(expected.phase), 'unknown expected phase');
  assert.ok(SHA40.test(expected.sourceRevision), 'expected source revision invalid');
  hash(expected.policyDigest, 'expected policy');
  const claim = plan.claims.find(claim => claim.task === expected.task);
  assert.ok(claim, 'unknown expected task');
  const phase = claim[expected.phase];
  exact(observed, ['schemaVersion', 'kind', 'task', 'phase', 'receiptClass', 'developmentBase',
    'sourceRevision', 'sourceDigest', 'policyDigest', 'scope', 'outcome', 'evidence'], 'observation');
  assert.equal(observed.schemaVersion, 1);
  assert.equal(observed.kind, 'V51ClaudeClaimObservationV1');
  assert.equal(observed.task, expected.task, 'observation task mismatch');
  assert.equal(observed.phase, expected.phase, 'observation phase mismatch');
  assert.equal(observed.receiptClass, phase.receiptClass, 'observation evidence class mismatch');
  assert.equal(observed.developmentBase, plan.developmentBase, 'observation base mismatch');
  assert.equal(observed.sourceRevision, expected.sourceRevision, 'observation source revision mismatch');
  assert.equal(observed.sourceDigest, plan.sourceDigest, 'observation source digest mismatch');
  assert.equal(observed.policyDigest, expected.policyDigest, 'observation policy mismatch');
  assert.deepEqual(observed.scope, phase.scope, 'observation host/platform/capability scope mismatch');
  assert.equal(observed.outcome, 'PASS', 'non-PASS observation cannot satisfy even structural completeness');
  assert.ok(Array.isArray(observed.evidence), 'observation evidence must be an array');
  const ids = [];
  for (const evidence of observed.evidence) {
    exact(evidence, ['id', 'sha256'], 'observation evidence');
    text(evidence.id, 'evidence ID'); hash(evidence.sha256, 'evidence digest'); ids.push(evidence.id);
  }
  assert.equal(new Set(ids).size, ids.length, 'duplicate evidence');
  assert.deepEqual([...ids].sort(), [...phase.requiredEvidence].sort(), 'incomplete or unexpected phase evidence');
  // Supplied digests are not verification of bytes or provenance. The existing
  // protected consumers and Root admission must verify those independently.
  return Object.freeze({ structureValid: true, phase: expected.phase, authority: 'none',
    provenanceVerified: false, taskCompletion: 'BLOCKED' });
}

export function validateV50ClaudeExclusion(paths, hostIds) {
  assert.ok(Array.isArray(paths) && paths.every(path => typeof path === 'string'), 'invalid projection paths');
  assert.ok(Array.isArray(hostIds) && hostIds.every(host => typeof host === 'string'), 'invalid host IDs');
  for (const path of paths) {
    assert.ok(path && !path.startsWith('/') && !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..'), 'noncanonical projection path');
    assert.ok(!path.toLowerCase().split('/').includes('.claude-plugin'), 'Claude manifest leaked into V5.0 projection');
  }
  assert.ok(!hostIds.includes('claude-code'), 'Claude host leaked into V5.0 release scope');
  return Object.freeze({ authority: 'none', suppliedListsOnly: true, inventoryCompletenessVerified: false });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('../docs/plans/', import.meta.url);
  const [plan, requirements, backlog] = await Promise.all(['v5-1-claude-claims.json', 'v5-1-requirements.json', 'v5-1-backlog.json']
    .map(async file => JSON.parse(await readFile(new URL(file, root), 'utf8'))));
  console.log(JSON.stringify(validateV51ClaudeClaimPlan(plan, requirements, backlog), null, 2));
}
