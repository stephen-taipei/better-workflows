import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { validateV51Catalog, validateV51DispatchPacket, validateV51PlanProjection, validateV51AmendmentMetadataDigest } from "../validate-v51-plan.mjs";

const base = new URL("../../docs/plans/", import.meta.url);
const [requirements, backlog] = await Promise.all(["v5-1-requirements.json", "v5-1-backlog.json"]
  .map(async name => JSON.parse(await readFile(new URL(name, base), "utf8"))));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function rebind(task) {
  task.contractDigest = digest(task.contract);
}

function setPaths(task, paths) {
  task.reservedPaths = paths;
  task.contract.reservedPaths = [...paths];
  rebind(task);
}

test("R9 retains 109 tracked leaves, 107 GA obligations and an acyclic task catalog", () => {
  assert.equal(validateV51Catalog(requirements, backlog).leaf, 109);
  assert.equal(requirements.gaEligibleTotal, 107);
});

test("website leaf91 retains fixed RC1 locales, compatibility and same-SHA readback", async () => {
  const row = requirements.rows.find(item => item.id === "91");
  for (const text of ["en", "zh-Hant-TW", "publicDocPath", "publicReferencePath", "同 SHA", "origin readback"])
    assert.ok(row.requirement.includes(text) || row.evidence.includes(text), "leaf91 compatibility contract missing " + text);
  const ownership = JSON.parse(await readFile(new URL("v5-0-rc2-locale-ownership.json", base), "utf8"));
  assert.deepEqual(ownership.existing, ["en", "zh-Hant-TW"]);
  const plan = await readFile(new URL("v5-1.md", base), "utf8");
  for (const text of ["RC1 既有兩個語系固定為 `en` 與 `zh-Hant-TW`", "首頁 `/`、`/en/`", "兩語系逐頁回歸", "origin readback", "任一既有語系退步即 HOLD"])
    assert.ok(plan.includes(text), "plan compatibility contract missing " + text);
});

for (const [name, mutate, expected] of [
  ...["en", "zh-Hant-TW", "publicDocPath", "publicReferencePath", "同 SHA", "origin readback"].map(value => [
    "website RC1 compatibility clause drift " + value, (r) => {
      const row = r.rows.find(item => item.id === "91");
      row.evidence = row.evidence.replaceAll(value, "synthetic:changed");
    }, /reviewed R8 rows drift/
  ]),
  ["unknown requirements authority field", (r) => { r.executionAuthority = true; }, /requirements root has unknown or missing field/],
  ...["schemaVersion", "kind", "sourceDigest", "developmentBase", "counts", "rows", "coverage", "leafTrackingTotal", "gaEligibleTotal"].map(key => [
    "missing requirements root field " + key, (r) => { delete r[key]; }, /requirements root has unknown or missing field/
  ]),
  ["unknown requirements count key", (r) => { r.counts.executionAuthority = 1; }, /requirements counts has unknown or missing field/],
  ...["必交", "決策", "條件", "研究"].map(key => [
    "missing requirements count key " + key, (r) => { delete r.counts[key]; }, /requirements counts has unknown or missing field/
  ]),
  ["unknown requirements coverage key", (r) => { r.coverage.executionAuthority = ["M-01"]; }, /requirements coverage has unknown or missing field/],
  ["missing requirements coverage leaf", (r) => { delete r.coverage["1"]; }, /requirements coverage has unknown or missing field/],
  ["coverage key substitution preserving the count", (r) => { r.coverage["33g"] = r.coverage["33f"]; delete r.coverage["33f"]; }, /requirements coverage has unknown or missing field/],
  ["requirements kind drift", (r) => { r.kind = "synthetic:forged"; }, /requirements kind drift/],
  ["non-array requirements rows", (r) => { r.rows = {}; }, /requirements rows must be an array/],
  ...["counts", "coverage"].flatMap(key => [null, [], "synthetic:map"].map(value => [
    "invalid requirements " + key + " map " + JSON.stringify(value), (r) => { r[key] = value; }, new RegExp("requirements " + key + " must be an object")
  ])),
  ["unknown backlog authority field", (_r, b) => { b.executionAuthority = true; }, /backlog root has unknown or missing field/],
  ["missing backlog source repository", (_r, b) => { delete b.sourceRepository; }, /backlog root has unknown or missing field/],
  ["missing backlog kind", (_r, b) => { delete b.kind; }, /backlog root has unknown or missing field/],
  ["undeclared task conclusion field", (_r, b) => { b.tasks[0].conclusion = "synthetic:unverified note"; }, /task record has unknown or missing field/],
  ["unknown task authority field", (_r, b) => { b.tasks[0].executionAuthority = true; }, /task record has unknown or missing field/],
  ["missing task title", (_r, b) => { delete b.tasks[0].title; }, /task record has unknown or missing field/],
  ["task title drift", (_r, b) => { b.tasks[0].title = "synthetic:changed task title"; }, /reviewed backlog metadata drift/],
  ["unexpected localeIds on a non-locale task", (_r, b) => { b.tasks[0].localeIds = ["synthetic-locale"]; }, /task record has unknown or missing field/],
  ["missing localeIds on a locale task", (_r, b) => { delete b.tasks.find(task => task.code === "RC2-L12").localeIds; }, /task record has unknown or missing field/],
  ["numeric readinessBlocker", (_r, b) => { b.tasks[0].readinessBlocker = 123; }, /task readinessBlocker missing/],
  ["blank readinessBlocker", (_r, b) => { b.tasks[0].readinessBlocker = " "; }, /task readinessBlocker missing/],
  ["unreviewed readOnlyInspectionAllowed addition", (_r, b) => {
    const task = b.tasks.find(item => !Object.hasOwn(item, "readOnlyInspectionAllowed"));
    assert.ok(task, "baseline must include a task without optional inspection flag");
    task.readOnlyInspectionAllowed = true;
  }, /reviewed backlog metadata drift/],
  ["unreviewed readOnlyInspectionAllowed removal", (_r, b) => {
    const task = b.tasks.find(item => Object.hasOwn(item, "readOnlyInspectionAllowed"));
    assert.ok(task, "baseline must include a task with inspection flag");
    delete task.readOnlyInspectionAllowed;
  }, /reviewed backlog metadata drift/],
  ["unreviewed readOnlyInspectionAllowed toggle", (_r, b) => {
    const task = b.tasks.find(item => Object.hasOwn(item, "readOnlyInspectionAllowed"));
    assert.ok(task, "baseline must include a task with inspection flag");
    task.readOnlyInspectionAllowed = !task.readOnlyInspectionAllowed;
  }, /reviewed backlog metadata drift/],
  ["string readOnlyInspectionAllowed", (_r, b) => { b.tasks[0].readOnlyInspectionAllowed = "true"; }, /must be boolean/],
  ["null dispatchPacket", (_r, b) => { b.tasks[0].dispatchPacket = null; }, /task dispatchPacket must be an object/],
  ["array dispatchPacket", (_r, b) => { b.tasks[0].dispatchPacket = []; }, /task dispatchPacket must be an object/],
  ["string dispatchPacket", (_r, b) => { b.tasks[0].dispatchPacket = "synthetic:packet"; }, /task dispatchPacket must be an object/],
  ["boolean task detail", (_r, b) => { b.tasks[0].detail = true; }, /task detail must be a string/],
  ["boolean task title", (_r, b) => { b.tasks[0].title = true; }, /task title missing/],
  ["blank task title", (_r, b) => { b.tasks[0].title = " "; }, /task title missing/],
  ["numeric backlog kind", (_r, b) => { b.kind = 123; }, /backlog kind missing/],
  ["missing website leaf", (r) => { r.rows = r.rows.filter(row => row.id !== "91"); }, /leaf ID set drift/],
  ["duplicate leaf ID", (r) => { r.rows.push(r.rows[0]); }, /duplicate requirement ID/],
  ["same-count leaf substitution", (r) => { r.rows.find(row => row.id === "33f").id = "33g"; }, /leaf ID set drift/],
  ["uncovered leaf", (r) => { r.coverage["1"] = []; }, /coverage drift/],
  ["dependency cycle", (_r, b) => { b.tasks[0].dependencies = [b.tasks[0].code]; }, /dependency cycle/],
  ["contract drift", (_r, b) => { b.tasks[0].contractDigest = "0".repeat(64); }, /contract digest drift/],
  ["old source mapping substitution", (_r, b) => { b.tasks[0].sources[0] = 999999; }, /reviewed backlog metadata drift/],
  ["self-rehashed forbidden change", (_r, b) => {
    b.tasks[0].contract.forbidden[0] = "synthetic:changed restriction"; rebind(b.tasks[0]);
  }, /reviewed backlog metadata drift/],
  ["self-rehashed beforeWrite change", (_r, b) => {
    b.tasks[0].contract.beforeWrite[0] = "synthetic:changed precondition"; rebind(b.tasks[0]);
  }, /reviewed backlog metadata drift/],
  ["duplicate RC2 locale across groups", (_r, b) => {
    const first = b.tasks.find(task => task.code === "RC2-L12");
    const second = b.tasks.find(task => task.code === "RC2-L14");
    second.localeIds[0] = first.localeIds[0]; second.contract.localeIds = [...second.localeIds]; rebind(second);
  }, /RC2 locale IDs must remain globally unique/],
  ["RC2 locale group swap preserving the global set", (_r, b) => {
    const first = b.tasks.find(task => task.code === "RC2-L12");
    const second = b.tasks.find(task => task.code === "RC2-L14");
    [first.localeIds[0], second.localeIds[0]] = [second.localeIds[0], first.localeIds[0]];
    for (const task of [first, second]) { task.contract.localeIds = [...task.localeIds]; rebind(task); }
  }, /reviewed backlog metadata drift/],
  ["same-count unique RC2 locale substitution", (_r, b) => {
    const task = b.tasks.find(task => task.code === "RC2-L14");
    task.localeIds[0] = "en"; task.contract.localeIds = [...task.localeIds]; rebind(task);
  }, /reviewed backlog metadata drift/],
  ["source identity drift", (r) => { r.sourceDigest = "0".repeat(64); }, /R7 source identity drift/],
  ["requirement text substitution", (r) => { r.rows[0].requirement = "changed acceptance"; }, /reviewed R8 rows drift/],
  ["same-count category swap", (r) => {
    const mandatory = r.rows.find(row => row.category === "必交");
    const decision = r.rows.find(row => row.category === "決策");
    [mandatory.category, decision.category] = [decision.category, mandatory.category];
  }, /reviewed R8 rows drift/],
  ["GA denominator includes P1", (r) => { r.gaEligibleTotal = 109; }, /P1 research must stay outside GA/],
  ["contract owner substitution", (_r, b) => { b.tasks[0].contract.owner = "W"; rebind(b.tasks[0]); }, /contract owner mismatch/],
  ["contract base substitution", (_r, b) => { b.tasks[0].contract.base = "0".repeat(40); rebind(b.tasks[0]); }, /contract base mismatch/],
  ["authority smuggled into a self-consistent planning contract", (_r, b) => {
    b.tasks[0].contract.executionAuthority = true; rebind(b.tasks[0]);
  }, /unknown or missing planning contract field/],
  ["READY without a frozen packet", (_r, b) => { b.tasks[0].state = "READY"; }, /READY needs a frozen dispatch packet/],
  ["P1 enabled", (r, b) => {
    const researchId = r.rows.find(row => row.category === "研究").id;
    b.tasks.find(task => task.requirements.includes(researchId)).state = "READY";
  }, /P1 remains outside/],
  ["mixed mandatory and conditional task marked READY", (_r, b) => {
    const task = b.tasks[0]; task.requirements = ["1", "34"]; task.state = "READY";
  }, /READY needs a frozen dispatch packet/],
  ["overlapping worker paths", (_r, b) => {
    const workers = b.tasks.filter(task => task.owner === "W");
    setPaths(workers[1], [...workers[1].reservedPaths, workers[0].reservedPaths[0]]);
  }, /overlapping worker scope/],
  ["parent-directory worker overlap", (_r, b) => {
    const workers = b.tasks.filter(task => task.owner === "W");
    setPaths(workers[0], ["task-owned/directory"]);
    setPaths(workers[1], ["task-owned/directory/child.mjs"]);
  }, /overlapping worker scope/],
  ...["C:\\work\\module.mjs", "\\\\host\\share\\module.mjs", "../module.mjs", "a/../module.mjs", "/module.mjs", "a//module.mjs"].map(unsafe => [
    "unsafe worker path " + unsafe, (_r, b) => setPaths(b.tasks.find(task => task.owner === "W"), [unsafe]), /unsafe reserved path/
  ])
]) test("rejects " + name, () => {
  const r = structuredClone(requirements), b = structuredClone(backlog);
  mutate(r, b);
  assert.throws(() => validateV51Catalog(r, b), expected);
});

test("allows declared mutable annotations on a non-READY task without granting admission", () => {
  const r = structuredClone(requirements), b = structuredClone(backlog);
  const task = b.tasks.find(item => item.code === "RF-01");
  task.detail = "synthetic:changed annotation";
  task.readinessBlocker = "synthetic:still missing real dependency receipts";
  task.dispatchPacket = { syntheticDraft: true };
  assert.equal(task.state, "BLOCKED");
  assert.equal(validateV51Catalog(r, b).tasks, 129);
});

test("allows conditional state to remain held without changing immutable metadata", () => {
  const r = structuredClone(requirements), b = structuredClone(backlog);
  const task = b.tasks.find(item => item.state === "UNTRIGGERED"
    && item.requirements.some(id => r.rows.find(row => row.id === id)?.category === "條件"));
  assert.ok(task);
  task.state = "BLOCKED";
  assert.equal(validateV51Catalog(r, b).tasks, 129);
});

// These are synthetic structural fixtures, not actual owners, leases or receipts.
function rebindPacket(packet) {
  const unsigned = structuredClone(packet);
  delete unsigned.packetDigest;
  packet.packetDigest = digest(unsigned);
}

function syntheticReadyFixture() {
  const r = structuredClone(requirements), b = structuredClone(backlog);
  const task = b.tasks.find(item => item.code === "M-02");
  assert.ok(task.dependencies.length > 0);
  task.state = "READY";
  const packet = {
    schemaVersion: 2, issue: task.code,
    owner: { id: "synthetic:test-owner", role: task.owner },
    integrationOwner: { id: "synthetic:test-integrator", role: "R" },
    reviewers: [{ id: "synthetic:test-reviewer", role: "Q" }],
    sourceDigest: r.sourceDigest, base: b.developmentBase, contractDigest: task.contractDigest,
    contractDetails: {
      schema: "synthetic:schema", exports: "synthetic:exports", errors: "synthetic:errors",
      callbacks: "synthetic:callbacks", bytes: "synthetic:bytes", storage: "synthetic:storage",
      sourceBinding: {
        base: b.developmentBase, head: b.developmentBase,
        files: [
          { path: "synthetic/input.mjs", status: "PRESENT", sha256: digest("synthetic:input") },
          { path: "synthetic/new-output.mjs", status: "ABSENT", sha256: null }
        ]
      },
      policyBinding: { id: "synthetic:policy", digest: digest("synthetic:policy") }
    },
    reservedPaths: [...task.reservedPaths],
    workspaceLease: {
      id: "synthetic:test-lease", ownerId: "synthetic:test-owner", branch: "codex/synthetic-test",
      worktreePath: "/synthetic/test-worktree", expiresAt: "2099-01-01T00:00:00.000Z"
    },
    environment: {
      host: { os: "synthetic-test-os", arch: "synthetic-test-arch" },
      nodeVersion: "v22.0.0-test.0", toolVersions: { syntheticTool: "synthetic-test-version" }
    },
    acceptance: {
      commands: ["synthetic:test-command"], positiveCases: ["synthetic:positive-case"],
      negativeCases: ["synthetic:negative-case"], compatibility: task.contract.compatibility
    },
    budget: {
      attempts: 2, deadline: "2099-01-01T00:00:00.000Z", tokenBudget: null,
      unknownTokens: "BOUND_BY_ATTEMPTS_AND_DEADLINE", noProgressLimit: 2
    },
    stopConditions: ["synthetic:stop-condition"],
    rollback: { trigger: "synthetic:failure-trigger", procedure: "synthetic:rollback-procedure" },
    lifecycle: {
      ownerId: "synthetic:test-owner", recordPidPpidDescendants: true, recordCwd: true,
      recordPortsSockets: true, cleanupMethod: "synthetic:cleanup-method"
    },
    dependencyReceipts: task.dependencies.map(code => ({
      task: code, sourceDigest: r.sourceDigest, base: b.developmentBase,
      receiptDigest: digest("synthetic:receipt:" + code)
    }))
  };
  rebindPacket(packet);
  task.dispatchPacket = packet;
  return { r, b, task, packet };
}

test("accepts complete synthetic packet structure without establishing catalog READY", () => {
  const { r, b, task, packet } = syntheticReadyFixture();
  assert.doesNotThrow(() => validateV51DispatchPacket(task, packet, b.developmentBase, r.sourceDigest, r));
  assert.throws(() => validateV51Catalog(r, b), /READY requires a reviewed dispatch packet baseline/);
});

test("canonical packet digest is independent of object key insertion order", () => {
  const { r, b, task, packet } = syntheticReadyFixture();
  const reordered = Object.fromEntries(Object.entries(packet).reverse());
  reordered.owner = Object.fromEntries(Object.entries(packet.owner).reverse());
  b.tasks.find(task => task.code === "M-02").dispatchPacket = reordered;
  assert.doesNotThrow(() => validateV51DispatchPacket(task, reordered, b.developmentBase, r.sourceDigest, r));
});

for (const [name, mutate] of [
  ["an otherwise complete synthetic packet", () => {}],
  ["self-rehashed source and policy substitution", p => {
    p.contractDetails.sourceBinding.files[0].sha256 = "0".repeat(64);
    p.contractDetails.policyBinding.digest = "0".repeat(64);
  }],
  ["self-rehashed dependency receipt substitution", p => { p.dependencyReceipts[0].receiptDigest = "0".repeat(64); }]
]) test("does not establish catalog READY from " + name, () => {
  const { r, b, task, packet } = syntheticReadyFixture();
  mutate(packet); rebindPacket(packet);
  assert.doesNotThrow(() => validateV51DispatchPacket(task, packet, b.developmentBase, r.sourceDigest, r));
  assert.throws(() => validateV51Catalog(r, b), /READY requires a reviewed dispatch packet baseline/);
});

test("mutable execution notes do not change the immutable planning baseline", () => {
  const b = structuredClone(backlog);
  b.tasks[0].detail = "synthetic:unverified execution note in the declared detail field";
  assert.equal(validateV51Catalog(requirements, b).tasks, 129);
});

for (const [name, mutate, expected, rehash = true] of [
  ["legacy minimal packet", p => { p.schemaVersion = 1; }, /READY needs a frozen dispatch packet/],
  ["missing lifecycle", p => { delete p.lifecycle; }, /dispatch packet has unknown or missing field/],
  ["unknown authority field", p => { p.executionAuthority = true; }, /dispatch packet has unknown or missing field/],
  ["unknown nested owner field", p => { p.owner.authority = "write"; }, /dispatch owner has unknown or missing field/],
  ["owner role mismatch", p => { p.owner.role = "W"; }, /dispatch owner role mismatch/],
  ["reviewer equals owner", p => { p.reviewers[0].id = p.owner.id; }, /dispatch reviewer must be distinct/],
  ["duplicate reviewers", p => { p.reviewers.push({ ...p.reviewers[0] }); }, /dispatch reviewer must be distinct/],
  ["missing reviewers", p => { p.reviewers = []; }, /dispatch reviewer missing/],
  ["source identity mismatch", p => { p.sourceDigest = "0".repeat(64); }, /dispatch source mismatch/],
  ["base mismatch", p => { p.base = "0".repeat(40); }, /dispatch base mismatch/],
  ["contract digest mismatch", p => { p.contractDigest = "0".repeat(64); }, /dispatch contract mismatch/],
  ["write paths mismatch", p => { p.reservedPaths = ["synthetic/other.mjs"]; }, /dispatch paths mismatch/],
  ["missing contract exports", p => { delete p.contractDetails.exports; }, /dispatch contract details has unknown or missing field/],
  ["source head mismatch", p => { p.contractDetails.sourceBinding.head = "0".repeat(40); }, /dispatch source binding head mismatch/],
  ["duplicate source file", p => { p.contractDetails.sourceBinding.files.push({ ...p.contractDetails.sourceBinding.files[0] }); }, /duplicate dispatch source path/],
  ["unsafe source path", p => { p.contractDetails.sourceBinding.files[0].path = "../input.mjs"; }, /unsafe dispatch source path/],
  ["invalid source file hash", p => { p.contractDetails.sourceBinding.files[0].sha256 = "unknown"; }, /dispatch source file digest invalid/],
  ["absent source with a hash", p => { p.contractDetails.sourceBinding.files[1].sha256 = "0".repeat(64); }, /absent source must have null digest/],
  ["missing policy binding", p => { delete p.contractDetails.policyBinding; }, /dispatch contract details has unknown or missing field/],
  ["lease owner mismatch", p => { p.workspaceLease.ownerId = "synthetic:other-owner"; }, /dispatch lease owner mismatch/],
  ["noncanonical expiry", p => { p.workspaceLease.expiresAt = "2099-01-01"; }, /dispatch lease expiry must be an ISO UTC timestamp/],
  ["missing host architecture", p => { delete p.environment.host.arch; }, /dispatch host has unknown or missing field/],
  ["missing tool versions", p => { p.environment.toolVersions = {}; }, /dispatch tool versions missing/],
  ["missing negative cases", p => { p.acceptance.negativeCases = []; }, /dispatch acceptance negativeCases missing/],
  ["missing rollback procedure", p => { p.rollback.procedure = ""; }, /dispatch rollback procedure missing/],
  ["unbounded attempts", p => { p.budget.attempts = 0; }, /invalid dispatch attempt budget/],
  ["unknown token policy", p => { p.budget.unknownTokens = "CONTINUE"; }, /invalid unknown token rule/],
  ["raised no-progress limit", p => { p.budget.noProgressLimit = 3; }, /dispatch no-progress limit must remain two/],
  ["lifecycle owner mismatch", p => { p.lifecycle.ownerId = "synthetic:other-owner"; }, /dispatch lifecycle owner mismatch/],
  ["disabled descendant tracking", p => { p.lifecycle.recordPidPpidDescendants = false; }, /dispatch lifecycle must record recordPidPpidDescendants/],
  ["missing direct dependency receipt", p => { p.dependencyReceipts.pop(); }, /dispatch dependency receipts mismatch/],
  ["duplicate direct dependency receipt", p => { p.dependencyReceipts.push({ ...p.dependencyReceipts[0] }); }, /duplicate dispatch dependency receipt/],
  ["dependency base mismatch", p => { p.dependencyReceipts[0].base = "0".repeat(40); }, /dispatch dependency receipt base mismatch/],
  ["dependency source mismatch", p => { p.dependencyReceipts[0].sourceDigest = "0".repeat(64); }, /dispatch dependency receipt source mismatch/],
  ["dependency digest malformed", p => { p.dependencyReceipts[0].receiptDigest = "unknown"; }, /dispatch dependency receipt digest invalid/],
  ["content drift without a new packet digest", p => { p.acceptance.positiveCases[0] = "synthetic:changed-case"; }, /dispatch packet digest drift/, false]
]) test("rejects READY " + name, () => {
  const { r, b, packet } = syntheticReadyFixture();
  mutate(packet);
  if (rehash) rebindPacket(packet);
  assert.throws(() => validateV51Catalog(r, b), expected);
});

// Portable lexical identities reject aliases even on a case-sensitive host.
// Unicode is deliberately outside this frozen ASCII path contract.
for (const [name, paths] of [
  ["case-aliased files", ["task-owned/Foo.mjs", "task-owned/foo.mjs"]],
  ["case-aliased parent-child", ["Task-Owned/Directory", "task-owned/directory/Child.mjs"]],
  ["case-aliased directory parents", ["task-owned/Dir/file.mjs", "TASK-OWNED/dir"]]
]) test("rejects portable worker overlap " + name, () => {
  const b = structuredClone(backlog), workers = b.tasks.filter(task => task.owner === "W");
  setPaths(workers[0], [paths[0]]); setPaths(workers[1], [paths[1]]);
  assert.throws(() => validateV51Catalog(requirements, b), /overlapping worker scope/);
});
const nonPortablePaths = ["task-owned/é.mjs", "task-owned/e\u0301.mjs", "task-owned/Ｆoo.mjs",
  "task-owned/İ.mjs", "task-owned/ß.mjs", "task-owned/CON.mjs", "task-owned/nul.tar.gz",
  "task-owned/COM1.log", "task-owned/lpt9", "task-owned/module.mjs.", "task-owned/module.mjs ",
  "task-owned/module.mjs:stream", "task-owned/MODULE~1.MJS", "task-owned/a\u0000.mjs",
  "task-owned/a\u001f.mjs", "task-owned/a\u007f.mjs", "task-owned/a*.mjs", "task-owned/a?.mjs",
  "task-owned/a|.mjs", "task-owned/a b.mjs"];
for (const path of nonPortablePaths) {
  test("rejects nonportable reserved path " + JSON.stringify(path), () => {
    const b = structuredClone(backlog); setPaths(b.tasks.find(task => task.owner === "W"), [path]);
    assert.throws(() => validateV51Catalog(requirements, b), /unsafe reserved path/);
  });
  test("rejects nonportable source path " + JSON.stringify(path), () => {
    const {r,b,task,packet} = syntheticReadyFixture();
    packet.contractDetails.sourceBinding.files[0].path = path; rebindPacket(packet);
    assert.throws(() => validateV51DispatchPacket(task, packet, b.developmentBase, r.sourceDigest, r), /unsafe dispatch source path/);
  });
}
for (const paths of [["synthetic/Foo.mjs", "synthetic/foo.mjs"], ["SYNTHETIC/Input.mjs", "synthetic/input.mjs"]])
  test("rejects case-aliased source paths " + paths.join(" / "), () => {
    const {r,b,task,packet} = syntheticReadyFixture();
    packet.contractDetails.sourceBinding.files = paths.map(path => ({path,status:"PRESENT",sha256:digest("synthetic:input")}));
    rebindPacket(packet);
    assert.throws(() => validateV51DispatchPacket(task, packet, b.developmentBase, r.sourceDigest, r), /duplicate dispatch source path/);
  });
for (const paths of [["synthetic/Foo.mjs", "synthetic/foo.mjs"], ["Task-Owned/Directory", "task-owned/directory/Child.mjs"]])
  test("rejects structural worker packet overlap " + paths.join(" / "), () => {
    const {r,b,task,packet} = syntheticReadyFixture(); task.owner = "W";task.contract.owner = "W";
    setPaths(task, paths); packet.owner.role = "W";packet.contractDigest = task.contractDigest;
    packet.reservedPaths = [...paths];rebindPacket(packet);
    assert.throws(() => validateV51DispatchPacket(task, packet, b.developmentBase, r.sourceDigest, r), /overlapping worker scope/);
  });
test("accepts distinct portable spellings without rewriting source identities", () => {
  const {r,b,task,packet} = syntheticReadyFixture();
  packet.contractDetails.sourceBinding.files = ["Synthetic/Foo-Bar_1.mjs", ".github/WORKFLOW.yml"].map(path => ({path,status:"PRESENT",sha256:digest("synthetic:input")}));
  const before = structuredClone(packet.contractDetails.sourceBinding.files); rebindPacket(packet);
  assert.doesNotThrow(() => validateV51DispatchPacket(task, packet, b.developmentBase, r.sourceDigest, r));
  assert.deepEqual(packet.contractDetails.sourceBinding.files, before);
});


test("dispatch SOP requires trusted actual admission checks before digest freeze and READY", async () => {
  const sop = await readFile(new URL("v5-1-dispatch.md", base), "utf8");
  const admission = sop.split("結構checker只檢查schema")[1]?.split("完整結構草稿")[0];
  assert.ok(admission, "Root admission paragraph is present");
  for (const clause of [
    "固定經審閱的packet digest及標READY之前", "可信的當次身份與授權證據",
    "owner／integrationOwner／reviewers的實際身份、角色、適用授權",
    "審查者依policy要求的獨立性", "實際host／工具能力、版本與可用性",
    "缺證據、僅有synthetic值或失配時保持BLOCKED",
    "結果符合該前置contract的可接受終態",
    "FAIL／HOLD／UNKNOWN／NOT_RUN或僅有格式正確的digest不能通過",
    "off／未觸發結論只在該前置contract明確接受",
    "包含Root保留路徑與共享facade",
    "重疊須先序列化或透過明確owner交接解除，未完成不得READY"
  ]) assert.ok(admission.includes(clause), "Root checklist must retain: " + clause);
});


function syntheticConditionalFixture(code = "R-06") {
  const f = syntheticReadyFixture();
  f.task.state = backlog.tasks.find(task => task.code === f.task.code).state;
  delete f.task.dispatchPacket;
  const task = f.b.tasks.find(task => task.code === code);
  assert.ok(task, "known conditional task");
  task.state = "READY";
  const packet = f.packet;
  packet.issue = task.code; packet.owner.role = task.owner; packet.contractDigest = task.contractDigest;
  packet.reservedPaths = [...task.reservedPaths]; packet.acceptance.compatibility = task.contract.compatibility;
  packet.dependencyReceipts = task.dependencies.map(code => ({
    task: code, sourceDigest: f.r.sourceDigest, base: f.b.developmentBase,
    receiptDigest: digest("synthetic:receipt:" + code)
  }));
  packet.conditionalTrigger = {
    evaluatedAt: "2098-12-31T00:00:00.000Z",
    bindings: task.requirements.map(id => f.r.rows.find(row => row.id === id))
      .filter(row => row.category === "條件").map(row => ({
        leafId: row.id, rowDigest: digest(row),
        criterionId: row.id === "34" ? "storage-hotspot-v1" : "track-r-entry-v1",
        evidenceDigest: digest("synthetic:trigger:" + row.id), sourceDigest: f.r.sourceDigest,
        base: f.b.developmentBase, policyDigest: packet.contractDetails.policyBinding.digest,
        observedAt: "2098-12-30T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z"
      }))
  };
  rebindPacket(packet); task.dispatchPacket = packet;
  return { ...f, task, packet };
}

for (const code of ["A-11", "R-01", "R-02", "R-03", "R-04", "R-05", "R-06"])
  test("complete synthetic conditional packet structure for " + code + " creates no catalog READY", () => {
    const {r,b,task,packet} = syntheticConditionalFixture(code);
    assert.doesNotThrow(() => validateV51DispatchPacket(task, packet, b.developmentBase, r.sourceDigest, r));
    assert.throws(() => validateV51Catalog(r,b), /READY requires a reviewed dispatch packet baseline/);
  });

for (const [name, mutate, error] of [
  ["missing trigger", p => {delete p.conditionalTrigger;}, /dispatch packet has unknown or missing field/],
  ["null trigger", p => {p.conditionalTrigger = null;}, /conditional trigger must be an object/],
  ["unknown trigger field", p => {p.conditionalTrigger.triggered = true;}, /conditional trigger has unknown or missing field/],
  ["missing evaluation", p => {delete p.conditionalTrigger.evaluatedAt;}, /conditional trigger has unknown or missing field/],
  ["bindings not an array", p => {p.conditionalTrigger.bindings = {};}, /conditional trigger bindings missing/],
  ["empty bindings", p => {p.conditionalTrigger.bindings = [];}, /conditional trigger leaves mismatch/],
  ["missing leaf", p => {p.conditionalTrigger.bindings.pop();}, /conditional trigger leaves mismatch/],
  ["duplicate leaf", p => {p.conditionalTrigger.bindings.push({...p.conditionalTrigger.bindings[0]});}, /duplicate conditional trigger leaf/],
  ["extra leaf", p => {p.conditionalTrigger.bindings.push({...p.conditionalTrigger.bindings[0],leafId:"34"});}, /conditional trigger leaves mismatch/],
  ["null binding", p => {p.conditionalTrigger.bindings[0]=null;}, /conditional trigger leaves mismatch/],
  ["unknown binding field", p => {p.conditionalTrigger.bindings[0].approved=true;}, /conditional trigger binding has unknown or missing field/],
  ["missing row digest", p => {delete p.conditionalTrigger.bindings[0].rowDigest;}, /conditional trigger binding has unknown or missing field/],
  ["row digest mismatch", p => {p.conditionalTrigger.bindings[0].rowDigest="0".repeat(64);}, /conditional trigger row mismatch/],
  ["row digest malformed", p => {p.conditionalTrigger.bindings[0].rowDigest="unknown";}, /conditional trigger row digest invalid/],
  ["criterion mismatch", p => {p.conditionalTrigger.bindings[0].criterionId="storage-hotspot-v1";}, /conditional trigger criterion mismatch/],
  ["adoption gate substituted for entry", p => {p.conditionalTrigger.bindings.find(x=>x.leafId==="43").criterionId="track-r-adoption-v1";}, /conditional trigger criterion mismatch/],
  ["evidence digest malformed", p => {p.conditionalTrigger.bindings[0].evidenceDigest="unknown";}, /conditional trigger evidence digest invalid/],
  ["source mismatch", p => {p.conditionalTrigger.bindings[0].sourceDigest="0".repeat(64);}, /conditional trigger source mismatch/],
  ["base mismatch", p => {p.conditionalTrigger.bindings[0].base="0".repeat(40);}, /conditional trigger base mismatch/],
  ["policy mismatch", p => {p.conditionalTrigger.bindings[0].policyDigest="0".repeat(64);}, /conditional trigger policy mismatch/],
  ["policy malformed", p => {p.conditionalTrigger.bindings[0].policyDigest="unknown";}, /conditional trigger policy digest invalid/],
  ["evaluation not canonical", p => {p.conditionalTrigger.evaluatedAt="2098-12-31";}, /conditional trigger evaluation must be an ISO UTC timestamp/],
  ["observation not canonical", p => {p.conditionalTrigger.bindings[0].observedAt="2098-12-30";}, /conditional trigger observation must be an ISO UTC timestamp/],
  ["expiry not canonical", p => {p.conditionalTrigger.bindings[0].expiresAt="2099-01-01";}, /conditional trigger expiry must be an ISO UTC timestamp/],
  ["observation after evaluation", p => {p.conditionalTrigger.bindings[0].observedAt="2098-12-31T00:00:00.001Z";}, /conditional trigger observation is not current/],
  ["expired at evaluation", p => {p.conditionalTrigger.bindings[0].expiresAt=p.conditionalTrigger.evaluatedAt;}, /conditional trigger observation is not current/],
  ["expiry before evaluation", p => {p.conditionalTrigger.bindings[0].expiresAt="2098-12-30T00:00:00.000Z";}, /conditional trigger observation is not current/],
  ["lease expired at snapshot", p => {p.workspaceLease.expiresAt=p.conditionalTrigger.evaluatedAt;}, /snapshot must precede lease and budget expiry/],
  ["budget expired at snapshot", p => {p.budget.deadline=p.conditionalTrigger.evaluatedAt;}, /snapshot must precede lease and budget expiry/],
  ["extended-year future observation", p => {p.conditionalTrigger.bindings[0].observedAt="+010000-01-01T00:00:00.000Z";}, /conditional trigger observation is not current/],
  ["extended-year future evaluation", p => {p.conditionalTrigger.evaluatedAt="+010000-01-01T00:00:00.000Z";}, /snapshot must precede lease and budget expiry/]
]) test("rejects conditional " + name + " even after rehash", () => {
  const {r,b,task,packet}=syntheticConditionalFixture();mutate(packet);rebindPacket(packet);
  assert.throws(()=>validateV51DispatchPacket(task,packet,b.developmentBase,r.sourceDigest,r),error);
});

for (const [name,mutate,error] of [
  ["missing context", () => undefined, /dispatch requirements context missing/],
  ["kind drift", r=>{r.kind="synthetic:changed";return r;}, /requirements kind drift/],
  ["source drift", r=>{r.sourceDigest="0".repeat(64);return r;}, /R7 source identity drift/],
  ["base drift", r=>{r.developmentBase="0".repeat(40);return r;}, /dispatch requirements base mismatch/],
  ["row criterion substitution", r=>{r.rows.find(x=>x.id==="43").requirement="synthetic:forged condition";return r;}, /reviewed R8 rows drift/],
  ["undeclared context field", r=>{r.triggered=true;return r;}, /requirements root has unknown or missing field/],
  ["category substitution", r=>{r.rows.find(x=>x.id==="43").category="必交";return r;}, /條件|必交/]
]) test("rejects conditional requirements " + name, () => {
  const {r,b,task,packet}=syntheticConditionalFixture();const context=mutate(r);
  assert.throws(()=>validateV51DispatchPacket(task,packet,b.developmentBase,requirements.sourceDigest,context),error);
});

test("nonconditional packet rejects conditional trigger field", () => {
  const {r,b,task,packet}=syntheticReadyFixture();packet.conditionalTrigger={evaluatedAt:"2098-12-31T00:00:00.000Z",bindings:[]};rebindPacket(packet);
  assert.throws(()=>validateV51DispatchPacket(task,packet,b.developmentBase,r.sourceDigest,r),/dispatch packet has unknown or missing field/);
});
test("nonconditional direct packet validation also requires fixed requirements context", () => {
  const {r,b,task,packet}=syntheticReadyFixture();
  assert.throws(()=>validateV51DispatchPacket(task,packet,b.developmentBase,r.sourceDigest),/dispatch requirements context missing/);
});
test("mixed mandatory and conditional structural packet binds only conditional leaves and cannot establish READY", () => {
  const {r,b,task,packet}=syntheticConditionalFixture();task.requirements.push("1");rebindPacket(packet);
  assert.doesNotThrow(()=>validateV51DispatchPacket(task,packet,b.developmentBase,r.sourceDigest,r));
  assert.throws(()=>validateV51Catalog(r,b),/READY requires a reviewed dispatch packet baseline/);
});
test("P1 cannot join a conditional structural packet", () => {
  const {r,b,task,packet}=syntheticConditionalFixture();task.requirements.push(r.rows.find(x=>x.category==="研究").id);rebindPacket(packet);
  assert.throws(()=>validateV51DispatchPacket(task,packet,b.developmentBase,r.sourceDigest,r),/P1 remains outside/);
});
test("synthetic trigger receipt replacement passes only structure and never catalog READY", () => {
  const {r,b,task,packet}=syntheticConditionalFixture();packet.conditionalTrigger.bindings[0].evidenceDigest=digest("synthetic:replacement");rebindPacket(packet);
  assert.doesNotThrow(()=>validateV51DispatchPacket(task,packet,b.developmentBase,r.sourceDigest,r));
  assert.throws(()=>validateV51Catalog(r,b),/READY requires a reviewed dispatch packet baseline/);
});
test("conditional SOP retains entry/adoption separation and actual evidence admission",async()=>{
  const sop=await readFile(new URL("v5-1-dispatch.md",base),"utf8");
  for(const clause of ["第五參數為完整 requirements context","34採`storage-hotspot-v1`","37–43採`track-r-entry-v1`","不能要求R-06在開工前已有自身benchmark結果","Root依evidenceDigest讀回實際證據","預註冊須早於查看codec結果，無須早於W0原始量測","當前固定READY表仍為空"])
    assert.ok(sop.includes(clause),"Retain conditional admission contract: "+clause);
});


test("execution status snapshot separates historical observations from current candidate acceptance", async () => {
  const status = await readFile(new URL("v5-1-execution-status.md", base), "utf8");
  for (const text of ["2026-10-03 公開開發基線歷史快照", "快照日期：2026-10-03", "## 當前進度與驗收依據", "issues/1", "issues/2", "本頁的歷史 PASS、BLOCK 與待提交描述不適用後續候選", "在此歷史觀察時點"])
    assert.ok(status.includes(text), "historical/current status boundary missing " + text);
  assert.ok(!status.includes("修正目前為待提交差額"), "unqualified stale current-candidate state remains");
});


test("plan leaf91 dependency projection matches the requirements catalog", async () => {
  const row = requirements.rows.find(item => item.id === "91");
  const plan = await readFile(new URL("v5-1.md", base), "utf8");
  const verifyProjection = text => validateV51PlanProjection(requirements, text);
  verifyProjection(plan);
  const prerequisite = "；R8建置前置RC2-SITE（39 deferred＋2existing）";
  assert.ok(row.dependencies.endsWith(prerequisite));
  assert.throws(() => verifyProjection(plan.replace(row.dependencies, row.dependencies.replace(prerequisite, ""))),
    /leaf91 dependencies drift/);
});


test("all plan rows and columns match the pinned requirements projection", async () => {
  const plan = await readFile(new URL("v5-1.md", base), "utf8");
  assert.deepEqual(validateV51PlanProjection(requirements, plan), { rows: 115, fields: 11 });
  const row91 = plan.split(String.fromCharCode(10)).find(line => line.startsWith("| 91 |"));
  const row92 = plan.split(String.fromCharCode(10)).find(line => line.startsWith("| 92 |"));
  assert.deepEqual(validateV51PlanProjection(requirements, plan.replace(row91 + String.fromCharCode(10) + row92, row92 + String.fromCharCode(10) + row91)), { rows: 115, fields: 11 });
  const fields = ["id", "requirement", "owner", "evidence", "negative", "rollback", "status", "wave", "category", "dependencies", "control"];
  for (const row of requirements.rows) {
    const original = plan.split("\n").find(line => line.startsWith(`| ${row.id} |`));
    for (const field of fields.slice(1)) {
      const changed = { ...row, [field]: row[field] + " synthetic:changed" };
      const line = "| " + fields.map(key => changed[key].replaceAll("|", "\\|")).join(" | ") + " |";
      assert.throws(() => validateV51PlanProjection(requirements, plan.replace(original, line)),
        error => error.message.includes(`plan leaf${row.id} ${field} drift`));
    }
  }
});

test("plan projection rejects duplicate, missing, added and malformed rows", async () => {
  const plan = await readFile(new URL("v5-1.md", base), "utf8");
  const first = plan.split("\n").find(line => line.startsWith("| 1 |"));
  for (const [changed, error] of [
    [plan.replace(first, first + "\n" + first), /plan row identity drift/],
    [plan.replace(first, ""), /plan unconsumed structural pipe unsupported/],
    [plan.replace(first, first + "\n" + "| 999 | invented |"), /plan leaf999 row shape drift/]
  ]) assert.throws(() => validateV51PlanProjection(requirements, changed), error);
  assert.throws(() => validateV51PlanProjection(requirements, plan.replace(first, first.slice(0, -1))), /plan leaf1 row shape drift/);
  assert.throws(() => validateV51PlanProjection(requirements, plan.replace("off\\|shadow", "off\\\\|shadow")), /plan leaf19 row shape drift/);
});

test("leaf86 permits independent issues while preserving the acceptance denominator", async () => {
  const row = requirements.rows.find(item => item.id === "86");
  assert.ok(row.negative.includes("拆分 issue 後改變 leaf 分母"));
  assert.ok(!row.negative.includes("把每個 matrix leaf 擴成新 issue"));
  const plan = await readFile(new URL("v5-1.md", base), "utf8");
  assert.throws(() => validateV51PlanProjection(requirements, plan.replace(row.negative,
    row.negative.replace("拆分 issue 後改變 leaf 分母", "把每個 matrix leaf 擴成新 issue"))), /plan leaf86 negative drift/);
});


test("requirement tables reject compact added and duplicate IDs without skipping legal Markdown rows", async () => {
  const plan = await readFile(new URL("v5-1.md", base), "utf8");
  const first = plan.split("\n").find(line => line.startsWith("| 1 |"));
  for (const prefix of ["|999|", "|1|", "|unexpected-id|"]) {
    const added = first.replace("| 1 |", prefix);
    assert.throws(() => validateV51PlanProjection(requirements,
      plan.replace(first, first + "\n" + added)), /plan row identity drift/);
  }
  for (const nonCanonical of [first.slice(1), " " + first, "unexpected-id"]) {
    assert.throws(() => validateV51PlanProjection(requirements,
      plan.replace(first, first + "\n" + nonCanonical)), /row shape drift/);
  }
  const header = "| # | 要求 | Owner | Evidence | Negative case | Rollback | Status | 波次 | GA | 直接依賴 | 控制 |";
  assert.throws(() => validateV51PlanProjection(requirements, plan.replace(header, "    " + header)), /table header format drift/);
  const separator = plan.split("\n")[plan.split("\n").indexOf(header) + 1];
  for (const malformed of [" " + separator, "    " + separator, separator.slice(1), separator.slice(0, -1)])
    assert.throws(() => validateV51PlanProjection(requirements, plan.replace(separator, malformed)), /plan table separator drift/);
  const firstTable = plan.slice(plan.indexOf(header), plan.indexOf("\n\n", plan.indexOf(header)));
  assert.throws(() => validateV51PlanProjection(requirements,
    plan.replace(firstTable, "```\n" + firstTable + "\n```")), /plan row identity drift/);
  const compact = plan.replace(first, first.replace("| 1 |", "|1|"));
  assert.deepEqual(validateV51PlanProjection(requirements, compact), { rows: 115, fields: 11 });
  assert.ok(plan.includes("off\\|shadow"));
  assert.deepEqual(validateV51PlanProjection(requirements, plan), { rows: 115, fields: 11 });
});


test("requirement table delimiters preserve every outer fragment and backslash parity", async () => {
  const plan = await readFile(new URL("v5-1.md", base), "utf8");
  const header = "| # | 要求 | Owner | Evidence | Negative case | Rollback | Status | 波次 | GA | 直接依賴 | 控制 |";
  const lines = plan.split("\n"), separator = lines[lines.indexOf(header) + 1];
  const first = lines.find(line => line.startsWith("| 1 |"));
  for (const [line, error] of [[header, /plan table header format drift/], [separator, /plan table separator drift/], [first, /plan leaf1 row shape drift/]]) {
    for (let slashes = 0; slashes <= 4; slashes++) {
      const malformed = line + "junk" + "\\".repeat(slashes) + "|";
      assert.throws(() => validateV51PlanProjection(requirements, plan.replace(line, malformed)), error);
    }
  }
  for (let slashes = 1; slashes <= 4; slashes++) {
    const changed = plan.replace("off\\|shadow", "off" + "\\".repeat(slashes) + "|shadow");
    if (slashes === 1) assert.deepEqual(validateV51PlanProjection(requirements, changed), { rows: 115, fields: 11 });
    else assert.throws(() => validateV51PlanProjection(requirements, changed), slashes % 2 === 0 ? /plan leaf19 row shape drift/ : /plan leaf19 evidence drift/);
  }
});

test("comment and fenced table examples cannot establish visible requirement rows", async () => {
  const plan = await readFile(new URL("v5-1.md", base), "utf8");
  const header = "| # | 要求 | Owner | Evidence | Negative case | Rollback | Status | 波次 | GA | 直接依賴 | 控制 |";
  const table = plan.slice(plan.indexOf(header), plan.indexOf("\n\n", plan.indexOf(header)));
  for (const gap of ["\n", "\n\n"]) {
    const comment = "<!--\n" + table + gap + "-->";
    assert.throws(() => validateV51PlanProjection(requirements, plan.replace(table, comment)), /plan row identity drift/);
    assert.deepEqual(validateV51PlanProjection(requirements, comment + "\n\n" + plan), { rows: 115, fields: 11 });
  }
  for (const example of [
    "<!--\n```\n" + table + "\n~~~\n\n-->\n\n",
    "```\n<!--\n" + table + "\n-->\n```\n\n",
    "~~~\n" + table + "\n~~~\n\n"
  ]) assert.deepEqual(validateV51PlanProjection(requirements, example + plan), { rows: 115, fields: 11 });
  const first = plan.split("\n").find(line => line.startsWith("| 1 |"));
  assert.throws(() => validateV51PlanProjection(requirements, plan.replace(first, "<!--\n" + first + "\n-->")), /row shape drift/);
});

test("closed projection grammar rejects unsupported HTML and block positions", async () => {
  const plan = await readFile(new URL("v5-1.md", base), "utf8");
  const header = "| # | 要求 | Owner | Evidence | Negative case | Rollback | Status | 波次 | GA | 直接依賴 | 控制 |";
  const table = plan.slice(plan.indexOf(header), plan.indexOf("\n\n", plan.indexOf(header)));
  for (const tag of ["pre", "script", "style", "textarea", "div", "PRE"]) {
    for (const padding of ["", " ", "    ", "\t"]) assert.throws(() => validateV51PlanProjection(requirements,
      plan.replace(table, padding + "<" + tag + ">\n" + table + "\n\n</" + tag + ">")), /plan raw HTML block unsupported/);
  }
  for (const comment of ["prefix <!--x-->", "<!--x--> <pre>", "<!--x--> ```", "    <!--x-->", "<!-- <!--nested--> -->", "-->"])
    assert.throws(() => validateV51PlanProjection(requirements, comment + "\n\n" + plan), /plan (?:HTML comment position|nested HTML comment) unsupported/);
  for (const unfinished of ["\n\n<!--", "\n\n```", "\n\n~~~"])
    assert.throws(() => validateV51PlanProjection(requirements, plan + unfinished), /plan unterminated block unsupported/);
  assert.throws(() => validateV51PlanProjection(requirements, "```bad`info\n" + table + "\n```\n\n" + plan), /plan backtick fence info unsupported/);
  assert.throws(() => validateV51PlanProjection(requirements, plan.replace(header, "paragraph\n" + header)), /plan table header format drift/);
});

test("inline HTML cannot hide matrices and only exact closed code spans quote markup", async () => {
  const plan = await readFile(new URL("v5-1.md", base), "utf8");
  const header = "| # | 要求 | Owner | Evidence | Negative case | Rollback | Status | 波次 | GA | 直接依賴 | 控制 |";
  const table = plan.slice(plan.indexOf(header), plan.indexOf("\n\n", plan.indexOf(header)));
  const validatePrefix = prefix => validateV51PlanProjection(requirements, prefix + "\n\n" + plan);
  for (const tag of ["script", "style", "textarea", "pre", "div", "SCRIPT"]) {
    assert.throws(() => validateV51PlanProjection(requirements,
      plan.replace(table, "prefix <" + tag + ">\n\n" + table + "\n\nprefix </" + tag + ">")), /plan raw HTML block unsupported/);
    for (const suffix of [">", " data-x='>'>", "\f>", "\v>"])
      assert.throws(() => validatePrefix("prefix <" + tag + suffix), /plan raw HTML block unsupported/);
    assert.throws(() => validatePrefix("prefix </" + tag + ">"), /plan raw HTML block unsupported/);
  }
  for (const markup of ["prefix <!DOCTYPE html>", "prefix <?xml version='1.0'?>", "prefix <custom_tag>"])
    assert.throws(() => validatePrefix(markup), /plan raw HTML block unsupported/);
  for (const incomplete of ["`unclosed <script>", "``unclosed `<script>```"])
    assert.throws(() => validatePrefix(incomplete), /plan incomplete inline code unsupported/);
  for (const quoted of ["`<stateRoot>`", "``a `<script>` b``", "paragraph ```a ``<script>`` b```", "plain < 100%", "\\<script>"])
    assert.deepEqual(validatePrefix(quoted), { rows: 115, fields: 11 });
  for (let slashes = 0; slashes <= 3; slashes++) {
    const prefix = "\\".repeat(slashes) + "`<script>`";
    if (slashes % 2 === 0) assert.deepEqual(validatePrefix(prefix), { rows: 115, fields: 11 });
    else assert.throws(() => validatePrefix(prefix), /plan raw HTML block unsupported/);
    const angle = "\\".repeat(slashes) + "<script>";
    if (slashes % 2 === 1) assert.deepEqual(validatePrefix(angle), { rows: 115, fields: 11 });
    else assert.throws(() => validatePrefix(angle), /plan raw HTML block unsupported/);
  }
  assert.deepEqual(validatePrefix("`<script>\\`"), { rows: 115, fields: 11 });
  assert.throws(() => validatePrefix("`safe\\` <script>"), /plan raw HTML block unsupported/);
  assert.throws(() => validatePrefix("``quoted ` still quoted`` <script>"), /plan raw HTML block unsupported/);
  for (const hidden of ["<!--\nprefix <script>\n-->", "```\nprefix <script>\n```"])
    assert.deepEqual(validatePrefix(hidden), { rows: 115, fields: 11 });
});

test("multiline delimiters and link or autolink context cannot quote raw HTML", async () => {
  const plan = await readFile(new URL("v5-1.md", base), "utf8");
  const check = prefix => validateV51PlanProjection(requirements, prefix + "\n\n" + plan);
  for (const prefix of ["`\n`<script>`", "``\n``<script>``", "plain `", "a ``partial` span"])
    assert.throws(() => check(prefix), /plan incomplete inline code unsupported/);
  for (const tag of ["script", "style", "textarea", "pre", "div"]) {
    for (const prefix of [
      "[x](u`)<" + tag + ">`", "[x]( `<" + tag + ">`)",
      "[x](\nu`)<" + tag + ">`", "[x]: u\n`<" + tag + ">`",
      "https://example.test/u` foo ` safe `<" + tag + ">`",
      "FTP://example.test/u` foo ` safe `<" + tag + ">`",
      "www.example.test/u` foo ` safe `<" + tag + ">`",
      "user`name@example.test` safe `<" + tag + ">`",
      "`[x](u)` then `<" + tag + ">`"
    ]) assert.throws(() => check(prefix), /plan ambiguous inline context unsupported/);
  }
  for (const prefix of [
    "`<stateRoot>` then [source](https://example.test)",
    "[source](https://example.test) then `plain code`",
    "[source](https://example.test)\n\n`<stateRoot>`",
    "[source](https://example.test)\n \t\n`<stateRoot>`",
    "ordinary ``code with ` inside`` and `<stateRoot>`"
  ]) assert.deepEqual(check(prefix), { rows: 115, fields: 11 });
});

test("projection block boundaries and cell margins use ASCII blank characters", async () => {
  const plan = await readFile(new URL("v5-1.md", base), "utf8");
  const header = "| # | 要求 | Owner | Evidence | Negative case | Rollback | Status | 波次 | GA | 直接依賴 | 控制 |";
  const first = plan.split("\n").find(line => line.startsWith("| 1 |"));
  for (const whitespace of ["\u00a0", "\u2003", "\uFEFF"]) {
    assert.throws(() => validateV51PlanProjection(requirements, plan.replace(header, whitespace + "\n" + header)), /plan table header format drift/);
    assert.throws(() => validateV51PlanProjection(requirements, plan.replace(first, first + "\n" + whitespace)), /row shape drift/);
    assert.throws(() => validateV51PlanProjection(requirements, plan.replace(first, first.replace("| 1 |", "|" + whitespace + "1 |"))), /plan row identity drift/);
    assert.throws(() => validateV51PlanProjection(requirements, "<!--ok-->" + whitespace + "\n\n" + plan), /plan HTML comment position unsupported/);
  }
  assert.throws(() => validateV51PlanProjection(requirements, "plain\rtext\n\n" + plan), /plan bare carriage return unsupported/);
  assert.deepEqual(validateV51PlanProjection(requirements, plan.replaceAll("\n", "\r\n")), { rows: 115, fields: 11 });
  assert.deepEqual(validateV51PlanProjection(requirements, plan.replace(header, " \t\n" + header)), { rows: 115, fields: 11 });
});


test("standalone projection pins the reviewed development base", async () => {
  const plan = await readFile(new URL("v5-1.md", base), "utf8");
  assert.equal(requirements.developmentBase, "9afb9e119d74ff721fe6e0cb75760a0c32e7de25");
  assert.deepEqual(validateV51PlanProjection(requirements, plan), { rows: 115, fields: 11 });
  const drifted = structuredClone(requirements);
  drifted.developmentBase = "b".repeat(40);
  assert.throws(() => validateV51PlanProjection(drifted, plan), /dispatch requirements base mismatch/);
});

test("additional requirement tables with omitted outer bars cannot hide rows", async () => {
  const plan = await readFile(new URL("v5-1.md", base), "utf8");
  const lines = plan.split("\n");
  const header = lines.find(line => line.startsWith("| # | 要求 |"));
  const separator = lines[lines.indexOf(header) + 1];
  const row = lines.find(line => line.startsWith("| 1 |"));
  const rows = [row, row.replace("| 1 |", "| 999 |"), row.replace("| pending |", "| PASS |")];
  assert.notEqual(rows[2], row, "contradictory status fixture changes a real cell");
  for (const first of ["#|", "# |", " #|", "\t#|", " # | ", "\t#\t|\t"]) {
    const unframed = header.replace("| # | ", first);
    for (const last of [true, false]) {
      const compact = last ? unframed : unframed.replace(/\|$/, "");
      for (const body of rows)
        assert.throws(() => validateV51PlanProjection(requirements,
          plan + "\n\n" + compact + "\n" + separator + "\n" + body + "\n"), /plan table header format drift/);
      assert.throws(() => validateV51PlanProjection(requirements,
        plan.replace(header, compact)), /plan table header format drift/);
    }
  }
  for (const padding of [" ", "   ", "\t"])
    assert.throws(() => validateV51PlanProjection(requirements,
      plan + "\n\n" + padding + header + "\n" + separator + "\n" + row + "\n"), /plan table header format drift/);
  const compact = header.replace("| # | ", "#|");
  for (const hidden of ["```\n" + compact + "\n" + separator + "\n" + row + "\n```",
                        "<!--\n" + compact + "\n" + separator + "\n" + row + "\n-->"])
    assert.deepEqual(validateV51PlanProjection(requirements, plan + "\n\n" + hidden), { rows: 115, fields: 11 });
  assert.deepEqual(validateV51PlanProjection(requirements,
    plan + "\n\n| 狀態 | 定義 |\n| --- | --- |\n| a | b |\n"), { rows: 115, fields: 11 });
});


async function closedTableFixture() {
  const plan = await readFile(new URL("v5-1.md", base), "utf8");
  const lines = plan.split("\n"), header = lines.find(line => line.startsWith("| # | 要求 |"));
  return { plan, header, separator: lines[lines.indexOf(header) + 1], row: lines.find(line => line.startsWith("| 1 |")) };
}
const tableText = (header, separator, row) => header + "\n" + separator + "\n" + row + "\n";

test("closed discovery rejects rendered-equivalent and changed requirement headers", async () => {
  const {plan,header,separator,row} = await closedTableFixture();
  const bodies = [row, row.replace("| 1 |", "| 999 |"), row.replace("| pending |", "| PASS |")];
  for (const marker of ["\\#", "&#35;", "&#x23;", "`#`", "**#**", "[#](https://example.test)"])
    for (const body of bodies) assert.throws(() => validateV51PlanProjection(requirements,
      plan + "\n\n" + tableText(header.replace("| # |", "| " + marker + " |"), separator, body)));
  const names = header.split("|").slice(1, -1).map(value => value.trim());
  assert.equal(names.length, 11);
  for (let i = 0; i < names.length; i++) {
    const changed = [...names]; changed[i] = "**" + changed[i] + "**";
    assert.throws(() => validateV51PlanProjection(requirements,
      plan + "\n\n" + tableText("| " + changed.join(" | ") + " |", separator, row)), /plan table header format drift/);
  }
});

test("closed discovery rejects every header and separator outer-frame omission", async () => {
  const {plan,header,separator,row} = await closedTableFixture();
  const frames = value => { const inner = value.slice(1, -1); return [value, inner + "|", "|" + inner, inner]; };
  for (const h of frames(header)) for (const sep of frames(separator))
    for (const body of [row, row.replace("| 1 |", "| 999 |"), row.replace("| pending |", "| PASS |")])
      assert.throws(() => validateV51PlanProjection(requirements, plan + "\n\n" + tableText(h, sep, body)));
});

test("unconsumed pipes reject requirement tables hidden by unsupported containers", async () => {
  const {plan,header,separator,row} = await closedTableFixture();
  const source = tableText(header.replace("| # |", "| \\# |"), separator, row);
  for (const prefix of [" ", "   ", "    ", "\t", "> ", "> > ", "- ", "* ", "+ ", "1. ", "1) "])
    assert.throws(() => validateV51PlanProjection(requirements,
      plan + "\n\n" + source.split("\n").map(line => line ? prefix + line : line).join("\n")));
});

test("all tables validate delimiter syntax and exact column widths", async () => {
  const {plan,header,separator} = await closedTableFixture();
  for (const cell of ["-", ":-", "-:", ":-:", "---", ":---:"])
    assert.deepEqual(validateV51PlanProjection(requirements, plan.replace(separator, "| " + Array(11).fill(cell).join(" | ") + " |")), {rows:115,fields:11});
  for (const cell of ["", "::---", "---::", "- -", "x---", "\\-"])
    assert.throws(() => validateV51PlanProjection(requirements,
      plan.replace(separator, "| " + Array(11).fill(cell).join(" | ") + " |")));
  for (const count of [10, 12]) assert.throws(() => validateV51PlanProjection(requirements,
    plan.replace(separator, "| " + Array(count).fill("---").join(" | ") + " |")), /plan table separator drift/);
  assert.throws(() => validateV51PlanProjection(requirements, plan.replace(header, header + " extra")), /plan table header format drift/);
});

test("frozen ordinary headers require equal-width bodies and reject unknown spellings", async () => {
  const {plan,row} = await closedTableFixture();
  const prefix = plan + "\n\n| 狀態 | 定義 |\n| --- | --- |\n";
  for (const body of ["| a | b |", "| `a\\|b` | c |"])
    assert.deepEqual(validateV51PlanProjection(requirements, prefix + body + "\n"), {rows:115,fields:11});
  for (const body of ["| a |", "| a | b | c |", row, "| `a|b` | c |"])
    assert.throws(() => validateV51PlanProjection(requirements, prefix + body + "\n"), /plan ordinary table row shape drift/);
  for (const h of ["| Ordinary | Columns |", "| **狀態** | 定義 |", "| 狀態 | &#23450;義 |"])
    assert.throws(() => validateV51PlanProjection(requirements,
      plan + "\n\n" + h + "\n| --- | --- |\n| a | b |\n"), /plan table header format drift/);
});

test("table discovery precedes inline-code exceptions while hidden examples remain opaque", async () => {
  const {plan,header,separator,row} = await closedTableFixture();
  for (const h of ["`" + header + "`", "``" + header + "``"])
    assert.throws(() => validateV51PlanProjection(requirements, plan + "\n\n" + tableText(h,separator,row)));
  const escaped = tableText(header.replace("| # |", "| &#35; |"), separator, row);
  for (const hidden of ["```\n" + escaped + "```", "<!--\n" + escaped + "-->"])
    assert.deepEqual(validateV51PlanProjection(requirements, plan + "\n\n" + hidden), {rows:115,fields:11});
});

test("visible non-table pipe coverage uses exact inline spans and backslash parity", async () => {
  const {plan} = await closedTableFixture();
  for (let slashes = 0; slashes <= 4; slashes++) {
    const text = plan + "\n\nplain " + "\\".repeat(slashes) + "| text\n";
    if (slashes % 2) assert.deepEqual(validateV51PlanProjection(requirements,text),{rows:115,fields:11});
    else assert.throws(()=>validateV51PlanProjection(requirements,text),/plan unconsumed structural pipe unsupported/);
  }
  for (const quoted of ["`a|b`", "``a `|` b``", "text `|` after\\| literal"])
    assert.deepEqual(validateV51PlanProjection(requirements,plan+"\n\n"+quoted),{rows:115,fields:11});
  assert.throws(()=>validateV51PlanProjection(requirements,plan+"\n\n`safe` | stray"),/plan unconsumed structural pipe unsupported/);
});

test("ordinary table cells cannot pair backticks across structural pipes", async () => {
  const plan = await readFile(new URL("v5-1.md", base), "utf8");
  const prefix = "| 狀態 | 定義 |\n| --- | --- |\n";
  for (const row of [
    "| `<script> | ` |", "| ``<script> | `` |",
    "| `safe | <script>` |", "| `<script> \\\\| ` |"
  ]) assert.throws(() => validateV51PlanProjection(requirements, prefix + row + "\n\n" + plan),
    /plan incomplete inline code unsupported/);
  for (const row of [
    "| `<script>` | safe |", "| ``a `<script>` b`` | `<stateRoot>` |",
    "| `<script>\\|quoted` | safe |", "| safe\\|text | `<script>` |"
  ]) assert.deepEqual(validateV51PlanProjection(requirements, prefix + row + "\n\n" + plan),
    { rows: 115, fields: 11 });
  assert.throws(() => validateV51PlanProjection(requirements,
    prefix + "| `safe` | <script> |\n\n" + plan), /plan raw HTML block unsupported/);
});

for (const marker of ["```", "~~~"])
  for (const mutation of ["unknown ID", "duplicate ID", "contradictory status"])
    test(`list ${marker[0]} fence cannot hide a column-zero table with ${mutation}`, async () => {
      const plan = await readFile(new URL("v5-1.md", base), "utf8");
      const lines = plan.split("\n"), headerIndex = lines.findIndex(line => line.startsWith("| # |"));
      const first = lines.find(line => line.startsWith("| 1 |"));
      let added = first;
      if (mutation === "unknown ID") added = first.replace("| 1 |", "| 999 |");
      if (mutation === "contradictory status") {
        const row = first.split("|"); row[7] = " contradictory "; added = row.join("|");
      }
      const table = [lines[headerIndex], lines[headerIndex + 1], added].join("\n");
      for (const indent of [" ", "  ", "   ", "    ", "\t"])
        assert.throws(() => validateV51PlanProjection(requirements,
          plan + `\n\n- item\n${indent}${marker}\n\n${table}\n\n${indent}${marker}\n`),
          /plan fence container or indentation unsupported/);
    });

test("only separated top-level fence openers can mask example tables", async () => {
  const plan = await readFile(new URL("v5-1.md", base), "utf8");
  for (const marker of ["```", "~~~"]) {
    assert.throws(() => validateV51PlanProjection(requirements,
      plan + `\n\n- item\n${marker}\nexample\n${marker}\n`),
      /plan fence container or indentation unsupported/);
    assert.deepEqual(validateV51PlanProjection(requirements,
      plan + `\n\n${marker}\n| hidden | example |\n  ${marker}\n`), { rows: 115, fields: 11 });
  }
});

test("ordinary Setext headings without structural pipes remain outside table discovery", async () => {
  const {plan} = await closedTableFixture();
  for (const heading of ["ordinary heading\n---", "ordinary heading\n===", "`a|b`\n---"])
    assert.deepEqual(validateV51PlanProjection(requirements,plan+"\n\n"+heading+"\n"),{rows:115,fields:11});
  assert.throws(()=>validateV51PlanProjection(requirements,plan+"\n\nraw|heading\n---\n"));
});

test("dispatch SOP freezes the table grammar without creating READY or runtime authority", async () => {
  const sop = await readFile(new URL("v5-1-dispatch.md",base),"utf8");
  for (const clause of ["先由相鄰 delimiter row 發現表格", "每一個 body row", "固定的完整 header vectors", "不由當次待驗文件建立 allowlist", "未被合法表格消費", "先發現表格，再適用 inline", "102／100／122 分母不變"])
    assert.ok(sop.includes(clause),"closed source grammar must retain "+clause);
});

test("GOV-01 report path is pinned while dispatch remains BLOCKED", () => {
  const task = backlog.tasks.find(item => item.code === "GOV-01");
  assert.deepEqual(task.reservedPaths, ["docs/reports/v5.1/gov-01.md"]);
  assert.deepEqual(task.contract.reservedPaths, task.reservedPaths);
  assert.equal(task.state, "BLOCKED");
  assert.deepEqual(task.dependencies, []);
  assert.equal(task.contractDigest, digest(task.contract));
  assert.equal(validateV51Catalog(requirements, backlog).tasks, 129);
});

test("GOV-01 placeholder restoration rejects even with a recomputed contract digest", () => {
  const changed = structuredClone(backlog);
  const task = changed.tasks.find(item => item.code === "GOV-01");
  setPaths(task, ["Root serialized integration; exact files must be frozen in dispatch packet"]);
  assert.throws(() => validateV51Catalog(requirements, changed), /reviewed backlog metadata drift/);
});

test("GOV-01 forged contract digest rejects despite pinned report paths", () => {
  const changed = structuredClone(backlog);
  changed.tasks.find(item => item.code === "GOV-01").contractDigest = "0".repeat(64);
  assert.throws(() => validateV51Catalog(requirements, changed), /contract digest drift GOV-01/);
});

// Reproduces the stale documentation anchor that blocked the native review.
const amendmentText = await readFile(new URL("v5-1-claude-amendment.md", base), "utf8");
const amendmentDeclaration = "The current reviewed backlog metadata digest is";
const amendmentDigest = "a5b5a5f3da8050d1673f5c9e8a9683d943876edceb9beee3ad522d3a06af4e00";

test("amendment projects the current reviewed backlog metadata anchor", () => {
  assert.deepEqual(validateV51AmendmentMetadataDigest(amendmentText), { metadataDigest: amendmentDigest });
  assert.deepEqual(validateV51AmendmentMetadataDigest(amendmentText.replace(/\n/g, "\r\n")),
    { metadataDigest: amendmentDigest });
});

test("amendment rejects the historical stale metadata anchor", () => {
  const stale = amendmentText.replace(amendmentDigest,
    "e5c8d530b36362a3a83bc1ee52651bc01963a4d750da3d48857e17b8fd6c9fcc");
  assert.notEqual(stale, amendmentText);
  assert.throws(() => validateV51AmendmentMetadataDigest(stale), /amendment metadata digest drift/);
});

test("amendment rejects a missing current metadata declaration", () => {
  assert.throws(() => validateV51AmendmentMetadataDigest(amendmentText.replace(amendmentDeclaration, "Removed declaration")),
    /exactly one current metadata digest declaration/);
});

test("amendment rejects duplicate and contradictory current metadata declarations", () => {
  for (const extra of [amendmentDigest, "0".repeat(64), "malformed"]) {
    assert.throws(() => validateV51AmendmentMetadataDigest(amendmentText +
      "\n" + amendmentDeclaration + "\n`" + extra + "`\n"), /exactly one current metadata digest declaration/);
  }
});

test("amendment rejects noncanonical digest text and missing projection input", () => {
  for (const bad of [amendmentDigest.toUpperCase(), "0".repeat(63), "g".repeat(64)])
    assert.throws(() => validateV51AmendmentMetadataDigest(amendmentText.replace(amendmentDigest, bad)),
      /amendment metadata digest format drift/);
  for (const value of [null, undefined, {}, []])
    assert.throws(() => validateV51AmendmentMetadataDigest(value), /amendment projection text missing/);
  assert.throws(() => validateV51AmendmentMetadataDigest(amendmentText.replace(/\n/g, "\r")),
    /amendment bare carriage return unsupported/);
});
