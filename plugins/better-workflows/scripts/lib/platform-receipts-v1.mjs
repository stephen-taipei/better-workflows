// SPDX-License-Identifier: AGPL-3.0-only
// Pure JSON structural evaluation. No filesystem, clock, execution or trust authority.
import { createHash } from 'node:crypto'

export const PLATFORM_RECEIPTS_SCHEMA_VERSION = 1
export const PLATFORM_RECEIPTS_LIMITS = Object.freeze({
  maxInputBytes: 1024 * 1024,
  maxDepth: 12,
  maxNodes: 10000,
  maxStringBytes: 64 * 1024,
  maxReceipts: 256
})

const SHA1 = /^[a-f0-9]{40}$/
const SHA256 = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/
const PLATFORMS = ['darwin', 'linux', 'win32']
const RESULTS = ['PASS', 'FAIL', 'HOLD', 'UNKNOWN', 'SKIP', 'CANCELLED', 'NOT_RUN']
const PROVENANCE = ['reported-execution', 'synthetic', 'fixture', 'mock']
const CLEANUP = ['PASS', 'FAIL', 'UNKNOWN', 'NOT_RUN']
const CONTROL = ['posix-owned-process-group', 'windows-job-object', 'none']
const CONTRACT_KEYS = ['schemaVersion', 'kind', 'candidateSha', 'suite', 'frozenAt', 'expiresAt', 'nodePolicy', 'tuples']
const RECEIPT_KEYS = [
  'schemaVersion', 'kind', 'contractDigest', 'candidateSha', 'suiteDigest', 'tupleId',
  'platform', 'arch', 'nodeVersion', 'hostId', 'startedAt', 'finishedAt', 'command',
  'result', 'provenance', 'cleanup', 'processControl', 'evidenceDigest', 'logDigest',
  'delegatedCgroupDigest'
]

export class PlatformReceiptError extends Error {
  constructor(code, message, dataPath = '$') {
    super(message)
    this.name = 'PlatformReceiptError'
    this.code = code
    this.path = dataPath
  }
}

function requireValue(condition, code, message, dataPath) {
  if (!condition) throw new PlatformReceiptError(code, message, dataPath)
}

// Accept ordinary JSON data without invoking accessors, toJSON or prototype methods.
function snapshot(input) {
  const active = new Set()
  let nodes = 0
  let bytes = 0
  function charge(encoded, dataPath) {
    bytes += Buffer.byteLength(encoded, 'utf8')
    requireValue(bytes <= PLATFORM_RECEIPTS_LIMITS.maxInputBytes,
      'EPLATFORM_LIMIT', 'JSON byte limit exceeded', dataPath)
  }
  function visit(value, depth, dataPath) {
    requireValue(++nodes <= PLATFORM_RECEIPTS_LIMITS.maxNodes && depth <= PLATFORM_RECEIPTS_LIMITS.maxDepth,
      'EPLATFORM_LIMIT', 'JSON nesting or node limit exceeded', dataPath)
    if (value === null || typeof value === 'boolean') {
      charge(JSON.stringify(value), dataPath)
      return value
    }
    if (typeof value === 'string') {
      requireValue(Buffer.byteLength(value, 'utf8') <= PLATFORM_RECEIPTS_LIMITS.maxStringBytes,
        'EPLATFORM_LIMIT', 'JSON string limit exceeded', dataPath)
      charge(JSON.stringify(value), dataPath)
      return value
    }
    if (typeof value === 'number') {
      requireValue(Number.isFinite(value) && !Object.is(value, -0), 'EPLATFORM_INPUT', 'Non-JSON number', dataPath)
      charge(JSON.stringify(value), dataPath)
      return value
    }
    requireValue(typeof value === 'object', 'EPLATFORM_INPUT', 'Expected ordinary JSON data', dataPath)
    requireValue(!active.has(value), 'EPLATFORM_INPUT', 'Cyclic JSON data', dataPath)
    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    requireValue(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null,
      'EPLATFORM_INPUT', 'Unsupported object prototype', dataPath)
    active.add(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    requireValue(keys.length <= PLATFORM_RECEIPTS_LIMITS.maxNodes,
      'EPLATFORM_LIMIT', 'Object member limit exceeded', dataPath)
    for (const key of keys) {
      requireValue(typeof key === 'string', 'EPLATFORM_INPUT', 'Symbol properties are not JSON', dataPath)
      const descriptor = descriptors[key]
      requireValue(Object.hasOwn(descriptor, 'value'), 'EPLATFORM_INPUT', 'Accessors are not JSON', dataPath)
      requireValue(key === 'length' && array || descriptor.enumerable,
        'EPLATFORM_INPUT', 'Non-enumerable properties are not JSON', dataPath)
    }
    charge(array ? '[]' : '{}', dataPath)
    let result
    if (array) {
      const length = descriptors.length.value
      requireValue(length <= PLATFORM_RECEIPTS_LIMITS.maxNodes,
        'EPLATFORM_LIMIT', 'Array size limit exceeded', dataPath)
      requireValue(keys.length === length + 1, 'EPLATFORM_INPUT', 'Sparse or extended array', dataPath)
      result = []
      for (let i = 0; i < length; i++) {
        if (i > 0) charge(',', dataPath)
        requireValue(Object.hasOwn(descriptors, String(i)), 'EPLATFORM_INPUT', 'Sparse array', dataPath)
        result.push(visit(descriptors[i].value, depth + 1, `${dataPath}[${i}]`))
      }
    } else {
      result = {}
      for (const [index, key] of keys.entries()) {
        charge(`${index > 0 ? ',' : ''}${JSON.stringify(key)}:`, dataPath)
        Object.defineProperty(result, key, {
          value: visit(descriptors[key].value, depth + 1, `${dataPath}.${key}`),
          enumerable: true, configurable: true, writable: true
        })
      }
    }
    active.delete(value)
    return result
  }
  const result = visit(input, 0, '$')
  // No toJSON/function/accessor can survive the copy above.
  requireValue(Buffer.byteLength(JSON.stringify(result), 'utf8') <= PLATFORM_RECEIPTS_LIMITS.maxInputBytes,
    'EPLATFORM_LIMIT', 'JSON byte limit exceeded', '$')
  return result
}

function exactKeys(value, keys, code, dataPath) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), code, 'Expected object', dataPath)
  const actual = Object.keys(value)
  requireValue(actual.length === keys.length && keys.every(key => Object.hasOwn(value, key)),
    code, 'Unknown or missing field', dataPath)
}

function text(value, code, dataPath, maxBytes = 4096) {
  requireValue(typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value) &&
    Buffer.byteLength(value, 'utf8') <= maxBytes, code, 'Invalid bounded text', dataPath)
}

function identifier(value, code, dataPath) {
  requireValue(typeof value === 'string' && ID.test(value), code, 'Invalid identifier', dataPath)
}

function digest(value, code, dataPath, { nullable = false, sha1 = false } = {}) {
  requireValue(nullable && value === null || typeof value === 'string' && (sha1 ? SHA1 : SHA256).test(value),
    code, 'Invalid digest encoding', dataPath)
}

function timestamp(value, code, dataPath) {
  requireValue(typeof value === 'string' && UTC.test(value), code, 'Expected canonical UTC timestamp', dataPath)
  const time = Date.parse(value)
  requireValue(Number.isFinite(time) && new Date(time).toISOString() === value, code, 'Invalid calendar timestamp', dataPath)
  return time
}

function version(value, code, dataPath) {
  requireValue(typeof value === 'string' && VERSION.test(value), code, 'Expected exact stable Node version', dataPath)
  const [major, minor, patch] = value.split('.').map(Number)
  requireValue(major === 24 || major === 22 && minor >= 14, code, 'Unsupported Node baseline', dataPath)
  return { major, minor, patch }
}

function uniqueList(value, maximum, validate, code, dataPath) {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= maximum,
    code, 'Invalid bounded allowlist', dataPath)
  requireValue(new Set(value).size === value.length, code, 'Duplicate allowlist value', dataPath)
  value.forEach((item, i) => validate(item, code, `${dataPath}[${i}]`))
}

function command(value, code, dataPath) {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= 64, code, 'Invalid argv', dataPath)
  value.forEach((arg, index) => text(arg, code, `${dataPath}[${index}]`))
}

function validateContract(contract) {
  const code = 'EPLATFORM_CONTRACT'
  exactKeys(contract, CONTRACT_KEYS, code, '$.contract')
  requireValue(contract.schemaVersion === 1 && contract.kind === 'PlatformReceiptContractV1', code, 'Unsupported contract', '$.contract')
  digest(contract.candidateSha, code, '$.contract.candidateSha', { sha1: true })
  exactKeys(contract.suite, ['id', 'digest'], code, '$.contract.suite')
  identifier(contract.suite.id, code, '$.contract.suite.id')
  digest(contract.suite.digest, code, '$.contract.suite.digest')
  const frozen = timestamp(contract.frozenAt, code, '$.contract.frozenAt')
  const expires = timestamp(contract.expiresAt, code, '$.contract.expiresAt')
  requireValue(frozen < expires, code, 'Invalid freeze interval', '$.contract.expiresAt')
  exactKeys(contract.nodePolicy, ['id', 'versions'], code, '$.contract.nodePolicy')
  identifier(contract.nodePolicy.id, code, '$.contract.nodePolicy.id')
  uniqueList(contract.nodePolicy.versions, 64, version, code, '$.contract.nodePolicy.versions')
  requireValue([22, 24].every(major => contract.nodePolicy.versions.some(v => Number(v.split('.')[0]) === major)),
    code, 'Node policy must cover both required majors', '$.contract.nodePolicy.versions')
  requireValue(Array.isArray(contract.tuples) && contract.tuples.length === 6, code, 'Exactly six tuples are required', '$.contract.tuples')
  const ids = new Set()
  const pairs = new Set()
  for (const [i, tuple] of contract.tuples.entries()) {
    const at = `$.contract.tuples[${i}]`
    exactKeys(tuple, ['id', 'platform', 'nodeMajor', 'architectures', 'hostIds', 'command'], code, at)
    identifier(tuple.id, code, `${at}.id`)
    requireValue(PLATFORMS.includes(tuple.platform) && [22, 24].includes(tuple.nodeMajor), code, 'Unsupported tuple', at)
    const pair = `${tuple.platform}:${tuple.nodeMajor}`
    requireValue(!ids.has(tuple.id) && !pairs.has(pair), code, 'Duplicate tuple identity', at)
    ids.add(tuple.id)
    pairs.add(pair)
    uniqueList(tuple.architectures, 32, identifier, code, `${at}.architectures`)
    uniqueList(tuple.hostIds, 32, identifier, code, `${at}.hostIds`)
    command(tuple.command, code, `${at}.command`)
  }
  return contract
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function contractDigest(contract) {
  return createHash('sha256').update(canonical(contract), 'utf8').digest('hex')
}

export function validatePlatformReceiptContractV1(contract) {
  return validateContract(snapshot(contract))
}

export function platformReceiptContractDigestV1(contract) {
  return contractDigest(validatePlatformReceiptContractV1(contract))
}

function validateReceipt(receipt, index, contract, pin, at) {
  const code = 'EPLATFORM_RECEIPT'
  const base = `$.receipts[${index}]`
  exactKeys(receipt, RECEIPT_KEYS, code, base)
  requireValue(receipt.schemaVersion === 1 && receipt.kind === 'PlatformReceiptV1', code, 'Unsupported receipt', base)
  for (const key of ['contractDigest', 'suiteDigest']) digest(receipt[key], code, `${base}.${key}`)
  digest(receipt.candidateSha, code, `${base}.candidateSha`, { sha1: true })
  requireValue(receipt.contractDigest === pin && receipt.candidateSha === contract.candidateSha && receipt.suiteDigest === contract.suite.digest,
    code, 'Receipt binding drift', base)
  identifier(receipt.tupleId, code, `${base}.tupleId`)
  const tuple = contract.tuples.find(item => item.id === receipt.tupleId)
  requireValue(Boolean(tuple), code, 'Unknown tuple identity', `${base}.tupleId`)
  const parsed = version(receipt.nodeVersion, code, `${base}.nodeVersion`)
  requireValue(parsed.major === tuple.nodeMajor && contract.nodePolicy.versions.includes(receipt.nodeVersion), code, 'Unapproved Node version', `${base}.nodeVersion`)
  requireValue(receipt.platform === tuple.platform && tuple.architectures.includes(receipt.arch) && tuple.hostIds.includes(receipt.hostId),
    code, 'Platform, architecture or host drift', base)
  command(receipt.command, code, `${base}.command`)
  requireValue(canonical(receipt.command) === canonical(tuple.command), code, 'Command drift', `${base}.command`)
  const started = timestamp(receipt.startedAt, code, `${base}.startedAt`)
  const finished = timestamp(receipt.finishedAt, code, `${base}.finishedAt`)
  requireValue(started >= Date.parse(contract.frozenAt) && started <= finished && finished <= at && finished < Date.parse(contract.expiresAt),
    code, 'Receipt outside frozen observation interval', base)
  requireValue(RESULTS.includes(receipt.result), code, 'Unsupported reported result', `${base}.result`)
  exactKeys(receipt.provenance, ['kind', 'sourceId'], code, `${base}.provenance`)
  requireValue(PROVENANCE.includes(receipt.provenance.kind), code, 'Unsupported provenance declaration', `${base}.provenance.kind`)
  text(receipt.provenance.sourceId, code, `${base}.provenance.sourceId`)
  exactKeys(receipt.cleanup, ['status', 'evidenceDigest'], code, `${base}.cleanup`)
  requireValue(CLEANUP.includes(receipt.cleanup.status), code, 'Unsupported cleanup observation', `${base}.cleanup.status`)
  digest(receipt.cleanup.evidenceDigest, code, `${base}.cleanup.evidenceDigest`, { nullable: true })
  exactKeys(receipt.processControl, ['kind', 'evidenceDigest'], code, `${base}.processControl`)
  const control = receipt.processControl
  requireValue(CONTROL.includes(control.kind), code, 'Unsupported process-control declaration', `${base}.processControl.kind`)
  digest(control.evidenceDigest, code, `${base}.processControl.evidenceDigest`, { nullable: true })
  requireValue(control.kind !== 'none' || control.evidenceDigest === null, code, 'Absent control has contradictory evidence', `${base}.processControl`)
  const expectedControl = tuple.platform === 'win32' ? 'windows-job-object' : 'posix-owned-process-group'
  requireValue(control.kind === 'none' || control.kind === expectedControl, code, 'Platform evidence substitution', `${base}.processControl.kind`)
  for (const key of ['evidenceDigest', 'logDigest', 'delegatedCgroupDigest']) digest(receipt[key], code, `${base}.${key}`, { nullable: true })
  requireValue(receipt.delegatedCgroupDigest === null || receipt.platform === 'linux', code, 'Cgroup declaration on non-Linux tuple', `${base}.delegatedCgroupDigest`)
}

export function evaluatePlatformReceiptsV1(input) {
  const packet = snapshot(input)
  exactKeys(packet, ['contract', 'expectedContractDigest', 'evaluatedAt', 'receipts'], 'EPLATFORM_INPUT', '$')
  const contract = validateContract(packet.contract)
  const pin = contractDigest(contract)
  digest(packet.expectedContractDigest, 'EPLATFORM_BINDING', '$.expectedContractDigest')
  requireValue(packet.expectedContractDigest === pin, 'EPLATFORM_BINDING', 'Independent contract pin mismatch', '$.expectedContractDigest')
  const at = timestamp(packet.evaluatedAt, 'EPLATFORM_BINDING', '$.evaluatedAt')
  requireValue(at >= Date.parse(contract.frozenAt) && at < Date.parse(contract.expiresAt), 'EPLATFORM_BINDING', 'Evaluation outside contract validity', '$.evaluatedAt')
  requireValue(Array.isArray(packet.receipts), 'EPLATFORM_INPUT', 'Expected receipt array', '$.receipts')
  requireValue(packet.receipts.length <= PLATFORM_RECEIPTS_LIMITS.maxReceipts, 'EPLATFORM_LIMIT', 'Receipt count limit exceeded', '$.receipts')
  const requiredIds = contract.tuples.map(tuple => tuple.id)
  const occurrences = new Map()
  const counts = Object.fromEntries([...RESULTS, 'MALFORMED'].map(result => [result, 0]))
  const blockers = [{ code: 'NO_ACCEPTED_VERIFIER', index: null, tupleId: null }]
  const observations = packet.receipts.map((receipt, index) => {
    const tupleId = typeof receipt?.tupleId === 'string' ? receipt.tupleId : null
    if (requiredIds.includes(tupleId)) {
      if (!occurrences.has(tupleId)) occurrences.set(tupleId, [])
      occurrences.get(tupleId).push(index)
    }
    counts[RESULTS.includes(receipt?.result) ? receipt.result : 'MALFORMED']++
    const observation = { index, tupleId, validation: 'VALID', issues: [], receipt }
    try {
      validateReceipt(receipt, index, contract, pin, at)
    } catch (error) {
      if (!(error instanceof PlatformReceiptError)) throw error
      observation.validation = 'INVALID'
      observation.issues.push({ code: error.code, path: error.path, message: error.message })
    }
    return observation
  })
  const duplicates = requiredIds.filter(id => (occurrences.get(id)?.length || 0) > 1)
  for (const id of duplicates) {
    for (const index of occurrences.get(id)) {
      observations[index].validation = 'INVALID'
      observations[index].issues.push({ code: 'DUPLICATE_TUPLE', path: `$.receipts[${index}].tupleId`, message: 'Duplicate tuple observation' })
    }
  }
  const covered = new Set()
  for (const observation of observations) {
    const { receipt, index, tupleId } = observation
    const block = code => blockers.push({ code, index, tupleId })
    if (observation.validation === 'INVALID') {
      for (const issue of observation.issues) block(issue.code)
      continue
    }
    covered.add(tupleId)
    if (receipt.result !== 'PASS') block(`RESULT_${receipt.result}`)
    if (receipt.cleanup.status !== 'PASS') block(`CLEANUP_${receipt.cleanup.status}`)
    if (receipt.cleanup.evidenceDigest === null) block('CLEANUP_EVIDENCE_MISSING')
    if (receipt.evidenceDigest === null) block('EXECUTION_EVIDENCE_MISSING')
    if (receipt.logDigest === null) block('LOG_EVIDENCE_MISSING')
    if (receipt.processControl.kind === 'none') block('PROCESS_CONTROL_MISSING')
    if (receipt.processControl.evidenceDigest === null) block('PROCESS_EVIDENCE_MISSING')
    block(receipt.provenance.kind === 'reported-execution' ? 'PROVENANCE_UNVERIFIED' : `${receipt.provenance.kind.toUpperCase()}_NOT_ACTUAL`)
  }
  const missing = requiredIds.filter(id => !covered.has(id))
  for (const tupleId of missing) blockers.push({ code: 'MISSING_VALID_TUPLE', index: null, tupleId })
  return {
    schemaVersion: 1,
    kind: 'PlatformReceiptReportV1',
    candidateSha: contract.candidateSha,
    suiteDigest: contract.suite.digest,
    contractDigest: pin,
    evaluatedAt: packet.evaluatedAt,
    requiredTupleIds: requiredIds,
    structuralStatus: observations.some(item => item.validation === 'INVALID') ? 'INVALID' : missing.length ? 'INCOMPLETE' : 'COMPLETE',
    coverage: { required: 6, covered: covered.size, missing, duplicates },
    observations,
    reportedOutcomeCounts: counts,
    blockers,
    executionAcceptance: 'UNVERIFIED',
    trustedTupleCount: 0,
    authority: 'none'
  }
}
