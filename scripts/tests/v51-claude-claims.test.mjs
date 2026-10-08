import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateV51ClaudeClaimPlan, validateV51ClaudeClaimObservation, validateV50ClaudeExclusion } from '../validate-v51-claude-claims.mjs';
const root = new URL('../../docs/plans/', import.meta.url);
const [plan, requirements, backlog] = await Promise.all(['v5-1-claude-claims.json', 'v5-1-requirements.json', 'v5-1-backlog.json']
  .map(async file => JSON.parse(await readFile(new URL(file, root), 'utf8'))));
const clone = value => structuredClone(value);
function fixture(task = 'CC-05', phase = 'qualification') {
  const claim = plan.claims.find(claim => claim.task === task)[phase];
  const expected = { task, phase, sourceRevision: 'a'.repeat(40), policyDigest: 'b'.repeat(64) };
  const observed = { schemaVersion: 1, kind: 'V51ClaudeClaimObservationV1', task, phase,
    receiptClass: claim.receiptClass, developmentBase: plan.developmentBase,
    sourceRevision: expected.sourceRevision, sourceDigest: plan.sourceDigest,
    policyDigest: expected.policyDigest, scope: clone(claim.scope), outcome: 'PASS',
    evidence: claim.requiredEvidence.map(id => ({ id, sha256: 'c'.repeat(64) })) };
  return { observed, expected };
}
const check = (f, b = backlog) => validateV51ClaudeClaimObservation(plan, requirements, b, f.observed, f.expected);

test('R10 maps seven claims without reducing 109/107 obligations or granting authority', () => {
  assert.deepEqual(validateV51ClaudeClaimPlan(plan, requirements, backlog), { claims: 7, authority: 'none', taskCompletion: 'BLOCKED' });
  for (const task of plan.claims) for (const phase of ['development', 'qualification', 'release']) {
    const result = check(fixture(task.task, phase));
    assert.equal(result.provenanceVerified, false);
    assert.equal(result.taskCompletion, 'BLOCKED');
  }
});
for (const [label, mutate, error] of [
  ['wrong host', f => { f.observed.scope.host = 'codex'; }, /scope mismatch/],
  ['wrong platform', f => { f.observed.scope.platform = 'windows'; }, /scope mismatch/],
  ['expanded capability', f => { f.observed.scope.capabilities.push('write'); }, /scope mismatch/],
  ['stale base', f => { f.observed.developmentBase = 'd'.repeat(40); }, /base mismatch/],
  ['stale revision', f => { f.observed.sourceRevision = 'd'.repeat(40); }, /revision mismatch/],
  ['wrong source digest', f => { f.observed.sourceDigest = 'd'.repeat(64); }, /source digest mismatch/],
  ['wrong policy', f => { f.observed.policyDigest = 'd'.repeat(64); }, /policy mismatch/],
  ['missing policy', f => { delete f.observed.policyDigest; }, /missing fields/],
  ['empty expected policy', f => { f.expected.policyDigest = ''; }, /expected policy invalid/],
  ['incomplete raw/grader set', f => { f.observed.evidence.pop(); }, /phase evidence/],
  ['duplicate evidence', f => { f.observed.evidence.push(f.observed.evidence[0]); }, /duplicate evidence/],
  ['invalid evidence digest', f => { f.observed.evidence[0].sha256 = 'not-verified'; }, /evidence digest invalid/],
  ['self-declared READY', f => { f.observed.state = 'READY'; }, /unknown or missing fields/],
  ['self-declared completion', f => { f.observed.taskCompletion = 'COMPLETE'; }, /unknown or missing fields/],
  ['wrong evidence class', f => { f.observed.receiptClass = 'local-development'; }, /evidence class mismatch/],
  ...['HOLD', 'FAIL', 'UNKNOWN', 'NOT_RUN'].map(outcome => [outcome, f => { f.observed.outcome = outcome; }, /non-PASS/])
]) test(`rejects ${label}`, () => { const f = fixture(); mutate(f); assert.throws(() => check(f), error); });
for (const [from, to] of [['development', 'qualification'], ['qualification', 'release'], ['development', 'release']])
  test(`rejects ${from} evidence promoted to ${to}`, () => {
    const f = fixture('CC-05', from); f.expected.phase = to;
    assert.throws(() => check(f), /phase mismatch/);
  });
test('partial release evidence cannot satisfy the four-host release claim', () => {
  const f = fixture('CC-07', 'release'); f.observed.evidence = f.observed.evidence.filter(e => e.id !== 'qwen-conformance');
  assert.throws(() => check(f), /phase evidence/);
});
test('missing task edge cannot hide behind requirement coverage', () => {
  const b = clone(backlog); b.tasks.find(t => t.code === 'CC-01').dependencies = [];
  assert.throws(() => validateV51ClaudeClaimPlan(plan, requirements, b), /dependency drift|reviewed backlog metadata drift/);
});
test('self-declared catalog READY cannot be established by this planning revision', () => {
  const b = clone(backlog); b.tasks.find(t => t.code === 'CC-01').state = 'READY';
  assert.throws(() => validateV51ClaudeClaimPlan(plan, requirements, b), /cannot establish READY|READY needs/);
});
test('claim scope drift is rejected independently of self-declared receipt metadata', () => {
  const p = clone(plan); p.claims[0].development.scope.platform = 'windows';
  assert.throws(() => validateV51ClaudeClaimPlan(p, requirements, backlog), /claim plan drift/);
});
for (const path of ['.claude-plugin/marketplace.json', 'plugins/better-workflows/.claude-plugin/plugin.json', 'plugins/X/.CLAUDE-PLUGIN/plugin.json', '../.claude-plugin/plugin.json'])
  test(`rejects V5.0 manifest projection ${path}`, () => assert.throws(() => validateV50ClaudeExclusion([path], ['codex']), /leaked|noncanonical/));
test('filters supplied host lists without claiming a complete projection scan', () => {
  assert.equal(validateV50ClaudeExclusion(['plugins/better-workflows/.codex-plugin/plugin.json'], ['codex','gemini-cli','qwen-code']).authority, 'none');
  assert.throws(() => validateV50ClaudeExclusion([], ['claude-code']), /host leaked/);
});

test('rejects deleted unrelated requirement rows even when declared totals remain 109/107', () => {
  const r = clone(requirements); r.rows = r.rows.filter(row => row.id !== '1');
  assert.throws(() => validateV51ClaudeClaimPlan(plan, r, backlog), /leaf ID set drift|denominator drift|reviewed R8 rows drift/);
});
test('a supplied empty inventory never attests projection completeness', () => {
  assert.equal(validateV50ClaudeExclusion([], []).inventoryCompletenessVerified, false);
});

test('current dispatch baseline matches actual catalogs and labels older counts historical', async () => {
  const sop = await readFile(new URL('v5-1-dispatch.md', root), 'utf8');
  assert.ok(sop.includes(`R10 當前基線：${backlog.tasks.length} 張 task、${requirements.leafTrackingTotal} tracked leaves、${requirements.gaEligibleTotal} GA obligations。`));
  for (const line of sop.split('\n').filter(line => /102／100/.test(line))) assert.match(line, /歷史/);
});
