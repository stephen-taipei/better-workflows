import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  PlatformReceiptError,
  validatePlatformReceiptContractV1,
  platformReceiptContractDigestV1,
  evaluatePlatformReceiptsV1
} from '../lib/platform-receipts-v1.mjs'

// Synthetic contract examples, not approved security patches or host receipts.
const hash = n => n.repeat(64)
const start = '2026-09-22T01:00:00.000Z'
const finish = '2026-09-22T01:01:00.000Z'
const evaluatedAt = '2026-09-22T02:00:00.000Z'
const clone = value => structuredClone(value)

function contractFixture() {
  return {
    schemaVersion: 1,
    kind: 'PlatformReceiptContractV1',
    candidateSha: 'a'.repeat(40),
    suite: { id: 'synthetic-suite', digest: hash('b') },
    frozenAt: '2026-09-22T00:00:00.000Z',
    expiresAt: '2026-09-23T00:00:00.000Z',
    nodePolicy: { id: 'synthetic-patch-policy', versions: ['22.14.0', '24.0.0'] },
    tuples: ['darwin', 'linux', 'win32'].flatMap(platform => [22, 24].map(nodeMajor => ({
      id: `${platform}-node${nodeMajor}`,
      platform,
      nodeMajor,
      architectures: ['x64'],
      hostIds: [`synthetic-${platform}`],
      command: ['node', '--test', 'synthetic.test.mjs']
    })))
  }
}

// Independent oracle for the documented canonical form, using a JSON replacer
// key list rather than the implementation's recursive serializer.
function oracleDigest(contract) {
  const keys = new Set()
  JSON.stringify(contract, (key, value) => { if (key) keys.add(key); return value })
  const bytes = JSON.stringify(contract, [...keys].sort())
  return createHash('sha256').update(bytes).digest('hex')
}

function inputFixture() {
  const contract = contractFixture()
  const expectedContractDigest = oracleDigest(contract)
  return {
    contract,
    expectedContractDigest,
    evaluatedAt,
    receipts: contract.tuples.map(tuple => ({
      schemaVersion: 1,
      kind: 'PlatformReceiptV1',
      contractDigest: expectedContractDigest,
      candidateSha: contract.candidateSha,
      suiteDigest: contract.suite.digest,
      tupleId: tuple.id,
      platform: tuple.platform,
      arch: 'x64',
      nodeVersion: tuple.nodeMajor === 22 ? '22.14.0' : '24.0.0',
      hostId: tuple.hostIds[0],
      startedAt: start,
      finishedAt: finish,
      command: [...tuple.command],
      result: 'PASS',
      provenance: { kind: 'synthetic', sourceId: `fixture-${tuple.id}` },
      cleanup: { status: 'PASS', evidenceDigest: hash('c') },
      processControl: {
        kind: tuple.platform === 'win32' ? 'windows-job-object' : 'posix-owned-process-group',
        evidenceDigest: hash('d')
      },
      evidenceDigest: hash('e'),
      logDigest: hash('f'),
      delegatedCgroupDigest: null
    }))
  }
}

const isCode = code => error => error instanceof PlatformReceiptError && error.code === code
const reasons = report => report.blockers.map(item => item.code)

test('complete six-tuple synthetic shape never grants trusted execution', () => {
  const input = inputFixture()
  const report = evaluatePlatformReceiptsV1(input)
  assert.equal(report.structuralStatus, 'COMPLETE')
  assert.deepEqual(report.coverage, { required: 6, covered: 6, missing: [], duplicates: [] })
  assert.equal(report.executionAcceptance, 'UNVERIFIED')
  assert.equal(report.trustedTupleCount, 0)
  assert.equal(report.authority, 'none')
  assert.equal(report.observations.length, 6)
  assert.equal(report.reportedOutcomeCounts.PASS, 6)
  assert.ok(reasons(report).includes('NO_ACCEPTED_VERIFIER'))
  assert.ok(reasons(report).includes('SYNTHETIC_NOT_ACTUAL'))
  assert.deepEqual(report.observations[0].receipt, input.receipts[0])
})

test('contract digest matches an independent canonical JSON oracle', () => {
  const c = contractFixture()
  assert.equal(platformReceiptContractDigestV1(c), oracleDigest(c))
  const reordered = Object.fromEntries(Object.entries(c).reverse())
  assert.equal(platformReceiptContractDigestV1(reordered), oracleDigest(c))
  assert.notEqual(platformReceiptContractDigestV1({ ...c, tuples: [...c.tuples].reverse() }), oracleDigest(c))
})

test('contract validator and report are defensive snapshots', () => {
  const input = inputFixture()
  const before = clone(input)
  const validated = validatePlatformReceiptContractV1(input.contract)
  const report = evaluatePlatformReceiptsV1(input)
  assert.deepEqual(input, before)
  input.contract.tuples[0].command[0] = 'changed'
  input.receipts[0].cleanup.status = 'FAIL'
  assert.equal(validated.tuples[0].command[0], 'node')
  assert.equal(report.observations[0].receipt.cleanup.status, 'PASS')
})

test('empty observations preserve all six missing tuples', () => {
  const input = inputFixture()
  input.receipts = []
  const report = evaluatePlatformReceiptsV1(input)
  assert.equal(report.structuralStatus, 'INCOMPLETE')
  assert.equal(report.coverage.required, 6)
  assert.equal(report.coverage.covered, 0)
  assert.deepEqual(report.coverage.missing, input.contract.tuples.map(item => item.id))
  assert.equal(report.executionAcceptance, 'UNVERIFIED')
})

for (let index = 0; index < 6; index++) {
  test(`missing tuple ${index} does not shrink the denominator`, () => {
    const input = inputFixture()
    const [missing] = input.receipts.splice(index, 1)
    const report = evaluatePlatformReceiptsV1(input)
    assert.equal(report.structuralStatus, 'INCOMPLETE')
    assert.equal(report.coverage.covered, 5)
    assert.deepEqual(report.coverage.missing, [missing.tupleId])
  })
}

for (const conflicting of [false, true]) {
  test(`duplicate tuple rejected with all observations retained, conflicting=${conflicting}`, () => {
    const input = inputFixture()
    const duplicate = clone(input.receipts[0])
    if (conflicting) duplicate.result = 'FAIL'
    input.receipts.push(duplicate)
    const report = evaluatePlatformReceiptsV1(input)
    assert.equal(report.structuralStatus, 'INVALID')
    assert.equal(report.observations.length, 7)
    assert.deepEqual(report.coverage.duplicates, [duplicate.tupleId])
    for (const index of [0, 6]) {
      assert.ok(report.observations[index].issues.some(item => item.code === 'DUPLICATE_TUPLE'))
    }
    assert.equal(report.coverage.covered, 5)
  })
}

const receiptMutations = [
  ['candidate drift', r => { r.candidateSha = 'b'.repeat(40) }],
  ['suite drift', r => { r.suiteDigest = hash('a') }],
  ['contract drift', r => { r.contractDigest = hash('a') }],
  ['unknown tuple', r => { r.tupleId = 'unknown' }],
  ['platform mismatch', r => { r.platform = 'linux' }],
  ['unsupported architecture', r => { r.arch = 'arm64' }],
  ['unlisted host', r => { r.hostId = 'other-host' }],
  ['unapproved patch', r => { r.nodeVersion = '22.14.1' }],
  ['different major', r => { r.nodeVersion = '24.0.0' }],
  ['command drift', r => { r.command.push('--skip-safety') }],
  ['malformed SHA', r => { r.candidateSha = 'A'.repeat(40) }],
  ['malformed evidence digest', r => { r.evidenceDigest = 'bad' }],
  ['impossible calendar date', r => { r.startedAt = '2026-02-30T00:00:00.000Z' }],
  ['time without milliseconds', r => { r.startedAt = '2026-09-22T01:00:00Z' }],
  ['start before freeze', r => { r.startedAt = '2026-09-21T23:59:59.999Z' }],
  ['end before start', r => { r.finishedAt = '2026-09-22T00:30:00.000Z' }],
  ['future observation', r => { r.finishedAt = '2026-09-22T03:00:00.000Z' }],
  ['unknown receipt field', r => { r.supported = true }],
  ['false verified provenance', r => { r.provenance.verified = true }],
  ['unknown provenance kind', r => { r.provenance.kind = 'trusted-execution' }],
  ['unknown nested cleanup field', r => { r.cleanup.trusted = true }],
  ['missing result', r => { delete r.result }],
  ['non-Linux cgroup', r => { r.delegatedCgroupDigest = hash('c') }],
  ['Windows control substituted for POSIX', r => { r.processControl.kind = 'windows-job-object' }],
  ['none control with a digest', r => { r.processControl.kind = 'none' }]
]
for (const [name, mutate] of receiptMutations) {
  test(`invalid receipt: ${name}`, () => {
    const input = inputFixture()
    mutate(input.receipts[0])
    const report = evaluatePlatformReceiptsV1(input)
    assert.equal(report.structuralStatus, 'INVALID')
    assert.equal(report.observations.length, 6)
    assert.equal(report.observations[0].validation, 'INVALID')
    assert.ok(report.observations[0].issues.length > 0)
    assert.equal(report.coverage.covered, 5)
    assert.equal(report.executionAcceptance, 'UNVERIFIED')
  })
}

test('POSIX process groups do not satisfy either Windows tuple', () => {
  const input = inputFixture()
  for (const r of input.receipts.filter(r => r.platform === 'win32')) r.processControl.kind = 'posix-owned-process-group'
  const report = evaluatePlatformReceiptsV1(input)
  assert.equal(report.structuralStatus, 'INVALID')
  assert.equal(report.coverage.covered, 4)
})

for (const status of ['FAIL', 'HOLD', 'UNKNOWN', 'SKIP', 'CANCELLED', 'NOT_RUN']) {
  test(`reported ${status} is retained and blocks an execution claim`, () => {
    const input = inputFixture()
    input.receipts[0].result = status
    const report = evaluatePlatformReceiptsV1(input)
    assert.equal(report.structuralStatus, 'COMPLETE')
    assert.equal(report.reportedOutcomeCounts[status], 1)
    assert.equal(report.observations.length, 6)
    assert.ok(reasons(report).includes(`RESULT_${status}`))
    assert.equal(report.executionAcceptance, 'UNVERIFIED')
  })
}

for (const status of ['FAIL', 'UNKNOWN', 'NOT_RUN']) {
  test(`cleanup ${status} cannot count as an accepted PASS`, () => {
    const input = inputFixture()
    input.receipts[0].cleanup = { status, evidenceDigest: null }
    const report = evaluatePlatformReceiptsV1(input)
    assert.ok(reasons(report).includes(`CLEANUP_${status}`))
    assert.equal(report.trustedTupleCount, 0)
  })
}

for (const [name, mutate, code] of [
  ['cleanup digest', r => { r.cleanup.evidenceDigest = null }, 'CLEANUP_EVIDENCE_MISSING'],
  ['log digest', r => { r.logDigest = null }, 'LOG_EVIDENCE_MISSING'],
  ['execution digest', r => { r.evidenceDigest = null }, 'EXECUTION_EVIDENCE_MISSING'],
  ['process digest', r => { r.processControl.evidenceDigest = null }, 'PROCESS_EVIDENCE_MISSING'],
  ['process observation', r => { r.processControl = { kind: 'none', evidenceDigest: null } }, 'PROCESS_CONTROL_MISSING']
]) {
  test(`missing ${name} remains an explicit blocker`, () => {
    const input = inputFixture()
    mutate(input.receipts[0])
    const report = evaluatePlatformReceiptsV1(input)
    assert.ok(reasons(report).includes(code))
    assert.equal(report.executionAcceptance, 'UNVERIFIED')
  })
}

for (const kind of ['reported-execution', 'fixture', 'mock']) {
  test(`provenance ${kind} cannot authenticate itself`, () => {
    const input = inputFixture()
    for (const r of input.receipts) r.provenance.kind = kind
    const report = evaluatePlatformReceiptsV1(input)
    assert.equal(report.structuralStatus, 'COMPLETE')
    assert.equal(report.executionAcceptance, 'UNVERIFIED')
    assert.equal(report.trustedTupleCount, 0)
    assert.ok(reasons(report).includes(kind === 'reported-execution' ? 'PROVENANCE_UNVERIFIED' : `${kind.toUpperCase()}_NOT_ACTUAL`))
  })
}

test('delegated Linux cgroups are optional and never establish strong isolation', () => {
  const input = inputFixture()
  const without = evaluatePlatformReceiptsV1(input)
  for (const r of input.receipts.filter(r => r.platform === 'linux')) r.delegatedCgroupDigest = hash('a')
  const withCgroups = evaluatePlatformReceiptsV1(input)
  assert.equal(without.structuralStatus, 'COMPLETE')
  assert.equal(withCgroups.structuralStatus, 'COMPLETE')
  assert.deepEqual(without.blockers, withCgroups.blockers)
  assert.equal(withCgroups.executionAcceptance, 'UNVERIFIED')
})

const contractMutations = [
  ['denominator shrink', c => { c.tuples.pop() }],
  ['duplicate pair', c => { c.tuples[1] = { ...c.tuples[0], id: 'another-id' } }],
  ['duplicate ID', c => { c.tuples[1].id = c.tuples[0].id }],
  ['unsupported platform', c => { c.tuples[0].platform = 'freebsd' }],
  ['unsupported major', c => { c.tuples[0].nodeMajor = 23 }],
  ['wildcard architecture', c => { c.tuples[0].architectures = ['*'] }],
  ['empty hosts', c => { c.tuples[0].hostIds = [] }],
  ['duplicate hosts', c => { c.tuples[0].hostIds.push(c.tuples[0].hostIds[0]) }],
  ['unsupported policy major', c => { c.nodePolicy.versions.push('26.0.0') }],
  ['below 22.14 baseline', c => { c.nodePolicy.versions[0] = '22.13.1' }],
  ['prerelease policy', c => { c.nodePolicy.versions[0] = '22.14.0-rc.1' }],
  ['version prefix', c => { c.nodePolicy.versions[0] = 'v22.14.0' }],
  ['version leading zero', c => { c.nodePolicy.versions[0] = '22.014.0' }],
  ['missing 24 policy', c => { c.nodePolicy.versions.pop() }],
  ['duplicate patch', c => { c.nodePolicy.versions.push(c.nodePolicy.versions[0]) }],
  ['empty command', c => { c.tuples[0].command = [] }],
  ['invalid command control', c => { c.tuples[0].command[0] = 'node\n' }],
  ['freeze after expiry', c => { c.frozenAt = c.expiresAt }],
  ['invalid date', c => { c.frozenAt = '2026-02-30T00:00:00.000Z' }],
  ['unknown nested suite key', c => { c.suite.approved = true }]
]
for (const [name, mutate] of contractMutations) {
  test(`reject malformed contract: ${name}`, () => {
    const c = contractFixture()
    mutate(c)
    assert.throws(() => validatePlatformReceiptContractV1(c), isCode('EPLATFORM_CONTRACT'))
  })
}

test('changed inventory after observation fails the independently pinned digest', () => {
  const input = inputFixture()
  input.contract.tuples[0].hostIds.push('new-host')
  assert.throws(() => evaluatePlatformReceiptsV1(input), isCode('EPLATFORM_BINDING'))
})

test('changing both pins still cannot authenticate retrospective registration', () => {
  const input = inputFixture()
  input.contract.tuples[0].hostIds.push('new-host')
  input.expectedContractDigest = oracleDigest(input.contract)
  for (const r of input.receipts) r.contractDigest = input.expectedContractDigest
  const report = evaluatePlatformReceiptsV1(input)
  assert.equal(report.executionAcceptance, 'UNVERIFIED')
  assert.equal(report.trustedTupleCount, 0)
})

for (const time of ['2026-09-21T23:59:59.999Z', '2026-09-23T00:00:00.000Z']) {
  test(`evaluation outside the frozen validity interval: ${time}`, () => {
    const input = inputFixture()
    input.evaluatedAt = time
    assert.throws(() => evaluatePlatformReceiptsV1(input), isCode('EPLATFORM_BINDING'))
  })
}

test('null and malformed receipt entries retain their input indexes', () => {
  const input = inputFixture()
  input.receipts = [null, {}, 7]
  const report = evaluatePlatformReceiptsV1(input)
  assert.equal(report.structuralStatus, 'INVALID')
  assert.equal(report.reportedOutcomeCounts.MALFORMED, 3)
  assert.deepEqual(report.observations.map(r => r.index), [0, 1, 2])
  assert.equal(report.coverage.required, 6)
})

test('256 observations are allowed, 257 are rejected before evaluation', () => {
  const input = inputFixture()
  input.receipts = Array.from({ length: 256 }, () => null)
  assert.equal(evaluatePlatformReceiptsV1(input).observations.length, 256)
  input.receipts.push(null)
  assert.throws(() => evaluatePlatformReceiptsV1(input), isCode('EPLATFORM_LIMIT'))
})

test('getters and toJSON are rejected without being invoked', () => {
  let invoked = 0
  const getter = inputFixture()
  Object.defineProperty(getter.receipts[0], 'supported', { enumerable: true, get() { invoked++; return true } })
  assert.throws(() => evaluatePlatformReceiptsV1(getter), isCode('EPLATFORM_INPUT'))
  const toJSON = inputFixture()
  toJSON.receipts[0].toJSON = () => { invoked++; return {} }
  assert.throws(() => evaluatePlatformReceiptsV1(toJSON), isCode('EPLATFORM_INPUT'))
  assert.equal(invoked, 0)
})

for (const [name, mutate] of [
  ['cycles', input => { input.self = input }],
  ['sparse arrays', input => { delete input.receipts[0] }],
  ['named array fields', input => { input.receipts.extra = true }],
  ['symbol properties', input => { input.receipts[0][Symbol('trusted')] = true }],
  ['class instances', input => { input.receipts[0] = new Date() }],
  ['NaN', input => { input.receipts[0].schemaVersion = NaN }],
  ['unknown top-level fields', input => { input.trusted = true }]
]) {
  test(`reject non-JSON or unknown data: ${name}`, () => {
    const input = inputFixture()
    mutate(input)
    assert.throws(() => evaluatePlatformReceiptsV1(input), isCode('EPLATFORM_INPUT'))
  })
}

test('__proto__ cannot alter object prototypes', () => {
  const input = inputFixture()
  input.receipts[0] = JSON.parse('{"__proto__":{"polluted":true}}')
  const report = evaluatePlatformReceiptsV1(input)
  assert.equal(report.structuralStatus, 'INVALID')
  assert.equal({}.polluted, undefined)
})

test('oversized strings, total JSON bytes, depth and node count fail closed', () => {
  for (const make of [
    input => { input.receipts[0].evidenceDigest = 'x'.repeat(65537) },
    input => { input.receipts = Array.from({ length: 32 }, () => 'x'.repeat(40000)) },
    input => { let v = 0; for (let n = 0; n < 14; n++) v = { a: v }; input.receipts = [v] },
    input => { input.receipts = [Array.from({ length: 10001 }, () => null)] }
  ]) {
    const input = inputFixture()
    make(input)
    assert.throws(() => evaluatePlatformReceiptsV1(input), isCode('EPLATFORM_LIMIT'))
  }
})

test('evaluation is deterministic and independent of the ambient clock', () => {
  const input = inputFixture()
  const before = evaluatePlatformReceiptsV1(input)
  const original = Date.now
  try {
    Date.now = () => { throw new Error('ambient clock must not be called') }
    assert.deepEqual(evaluatePlatformReceiptsV1(input), before)
  } finally {
    Date.now = original
  }
})
