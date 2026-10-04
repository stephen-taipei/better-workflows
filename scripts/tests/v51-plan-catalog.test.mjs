import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { validateV51Catalog, validateV51DispatchPacket } from "../validate-v51-plan.mjs";

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

test("R8 retains 102 tracked leaves, 100 GA obligations and an acyclic task catalog", () => {
  assert.equal(validateV51Catalog(requirements, backlog).leaf, 102);
  assert.equal(requirements.gaEligibleTotal, 100);
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
  ["GA denominator includes P1", (r) => { r.gaEligibleTotal = 102; }, /P1 research must stay outside GA/],
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
  assert.equal(validateV51Catalog(r, b).tasks, 122);
});

test("allows conditional state to remain held without changing immutable metadata", () => {
  const r = structuredClone(requirements), b = structuredClone(backlog);
  const task = b.tasks.find(item => item.state === "UNTRIGGERED"
    && item.requirements.some(id => r.rows.find(row => row.id === id)?.category === "條件"));
  assert.ok(task);
  task.state = "BLOCKED";
  assert.equal(validateV51Catalog(r, b).tasks, 122);
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
  assert.equal(validateV51Catalog(requirements, b).tasks, 122);
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
