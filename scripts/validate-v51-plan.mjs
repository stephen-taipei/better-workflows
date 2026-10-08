import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Recorded private R7 source identity, verified at public extraction time.
// This structural checker grants no runtime, dispatch or effect authority.
const R7_SOURCE_DIGEST = "2694daf569ea621e21bbb607631c037034399a7f21c81042a7188acab4c4934b";
// Reviewed R8 public rows have a separate identity; this does not reread or
// authenticate the private original. An intentional matrix revision needs review.
// R9 (2026-10-07): owner added Claude Code host integration rows 93–99.
const R8_ROWS_DIGEST = "cc1c46f746805d189dceccff3df43bbb294d08d2ef73ef6960d2e7903b28aee4";
// Reviewed immutable planning metadata; mutable execution state stays outside.
const REVIEWED_BACKLOG_METADATA_DIGEST = "e911b5d2491ef597d76b888197ee7687644a29c7ef10fa07129704c68384cef9";
// No READY packet is currently reviewed. Root must verify actual source/policy,
// dependencies and admission before a reviewed revision adds a packet digest.
// A digest declared by the packet itself cannot establish that frozen baseline.
const REVIEWED_READY_PACKET_DIGESTS = Object.freeze({});
const IMMUTABLE_TASK_FIELDS = Object.freeze([
  "code", "title", "issueNumber", "sources", "owner", "version", "requirements", "dependencies",
  "reservedPaths", "contract", "localeIds", "dispatchMode", "readOnlyInspectionAllowed"
]);
// Only these execution annotations may vary without changing the pinned metadata.
// contractDigest is derived separately from the pinned planning contract.
const MUTABLE_TASK_FIELDS = Object.freeze(["state", "detail", "readinessBlocker", "dispatchPacket"]);
const BACKLOG_ROOT_FIELDS = Object.freeze([
  "developmentBase", "kind", "schemaVersion", "sourceNumberNamespace", "sourceRepository", "tasks"
]);
const REQUIREMENTS_ROOT_FIELDS = Object.freeze([
  "schemaVersion", "kind", "sourceDigest", "developmentBase", "counts", "rows", "coverage",
  "leafTrackingTotal", "gaEligibleTotal"
]);
const REQUIREMENT_COUNTS = Object.freeze({ 必交: 81, 決策: 17, 條件: 9, 研究: 2 });
const TASK_REQUIRED_FIELDS = Object.freeze([
  "code", "contract", "contractDigest", "dependencies", "detail", "dispatchMode", "issueNumber",
  "owner", "requirements", "reservedPaths", "sources", "state", "title", "version"
]);
const TASK_OPTIONAL_FIELDS = Object.freeze([
  "readOnlyInspectionAllowed", ...MUTABLE_TASK_FIELDS.filter(key => !TASK_REQUIRED_FIELDS.includes(key))
]);
const CONTRACT_KEYS = ["base", "beforeWrite", "code", "compatibility", "forbidden", "owner", "reservedPaths"];
const SUMMARY_IDS = new Set(["33", "36", "82", "87", "88", "89"]);
const SUB_IDS = ["33a", "33b", "33c", "33d", "33e", "33f",
  "36a", "36b", "82a", "82b", "87a", "87b", "88a", "88b", "89a", "89b"];
const EXPECTED_LEAVES = [...Array.from({ length: 99 }, (_, i) => String(i + 1))
  .filter(id => !SUMMARY_IDS.has(id)), ...SUB_IDS].sort();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function validatedRequirementsContext(requirements, base, sourceDigest) {
  assert.ok(requirements && typeof requirements === "object" && !Array.isArray(requirements), "dispatch requirements context missing");
  exact(requirements, REQUIREMENTS_ROOT_FIELDS, "requirements root");
  exact(requirements.counts, Object.keys(REQUIREMENT_COUNTS), "requirements counts");
  exact(requirements.coverage, EXPECTED_LEAVES, "requirements coverage");
  assert.equal(requirements.kind, "V51RequirementsCatalog", "requirements kind drift");
  assert.equal(requirements.schemaVersion, 1);
  assert.ok(Array.isArray(requirements.rows), "requirements rows must be an array");
  assert.equal(requirements.sourceDigest, R7_SOURCE_DIGEST, "R7 source identity drift");
  assert.equal(requirements.sourceDigest, sourceDigest, "dispatch requirements source mismatch");
  assert.equal(requirements.developmentBase, base, "dispatch requirements base mismatch");
  assert.match(base, /^[a-f0-9]{40}$/);
  const rowMap = new Map(requirements.rows.map(row => [row.id, row]));
  assert.equal(rowMap.size, requirements.rows.length, "duplicate requirement ID");
  const leaves = requirements.rows.filter(row => row.category !== "彙總");
  assert.deepEqual(leaves.map(row => row.id).sort(), EXPECTED_LEAVES, "leaf ID set drift");
  assert.equal(leaves.length, 109, "leaf denominator drift");
  assert.equal(requirements.leafTrackingTotal, 109);
  assert.equal(requirements.gaEligibleTotal, 107, "P1 research must stay outside GA");
  for (const [category, count] of Object.entries(REQUIREMENT_COUNTS)) {
    assert.equal(leaves.filter(row => row.category === category).length, count, category);
    assert.equal(requirements.counts[category], count);
  }
  assert.equal(rowMap.get("91")?.category, "必交", "website leaf missing");
  assert.equal(hash(requirements.rows), R8_ROWS_DIGEST, "reviewed R8 rows drift");
  return rowMap;
}


// Compare every canonical requirement column, including summary rows. This
// verifies the human-readable projection; it grants no runtime authority.
export function validateV51PlanProjection(requirements, planText) {
  validatedRequirementsContext(requirements, requirements?.developmentBase, requirements?.sourceDigest);
  assert.equal(typeof planText, "string", "plan projection text missing");
  assert.ok(!/\r(?!\n)/.test(planText), "plan bare carriage return unsupported");
  const fields = ["id", "requirement", "owner", "evidence", "negative", "rollback", "status", "wave", "category", "dependencies", "control"];
  const header = ["#", "要求", "Owner", "Evidence", "Negative case", "Rollback", "Status", "波次", "GA", "直接依賴", "控制"];
  // Frozen non-requirement table headers from reviewed J source. Never derive
  // this registry from the supplied projection. All eleven-column tables must
  // use the canonical requirement header; unknown header spellings reject.
  const otherHeaders = [
    [
      "ID／來源位置",
      "SHA-256"
    ],
    [
      "事件",
      "行為"
    ],
    [
      "來源",
      "主要內容",
      "涵蓋於"
    ],
    [
      "修訂",
      "基準",
      "內容"
    ],
    [
      "候選工作",
      "可研究的組合",
      "預期改善方向",
      "重要邊界"
    ],
    [
      "原因族群",
      "候選處理",
      "可自動化條件",
      "禁止事項"
    ],
    [
      "層次",
      "判定"
    ],
    [
      "層次",
      "建議限制"
    ],
    [
      "工作單元",
      "接回既有 V5.1 工作",
      "負責角色",
      "可獨立驗收的交付與收據",
      "必須拒絕的情境"
    ],
    [
      "建議",
      "決定、理由與規格落點"
    ],
    [
      "建議群",
      "決定與理由",
      "落點"
    ],
    [
      "循環",
      "處理什麼",
      "何時結束"
    ],
    [
      "情境",
      "frames",
      "page bytes",
      "content bytes",
      "重複 binding bytes",
      "cursor bytes",
      "封套佔比"
    ],
    [
      "情境",
      "派工策略"
    ],
    [
      "指標",
      "用途"
    ],
    [
      "指標",
      "真正代表什麼"
    ],
    [
      "方向",
      "要回答什麼",
      "適用情況"
    ],
    [
      "方法",
      "對 BW 的用途",
      "例子",
      "必須避免的錯誤"
    ],
    [
      "格式候選",
      "BW 中的比較位置",
      "進入正式路徑前的特別條件"
    ],
    [
      "機制",
      "BW 用途",
      "主要收益",
      "優先級",
      "邊界"
    ],
    [
      "檔案",
      "SHA-256"
    ],
    [
      "檔案",
      "公開基準行數",
      "處理"
    ],
    [
      "次要拆解",
      "用途"
    ],
    [
      "波次",
      "交付",
      "進入與退出條件"
    ],
    [
      "熱點",
      "位置",
      "現況",
      "候選處理"
    ],
    [
      "版本",
      "內容",
      "要驗證的問題"
    ],
    [
      "狀態",
      "定義"
    ],
    [
      "維度",
      "BW 要釐清的問題"
    ],
    [
      "能力域",
      "V5.1 對應",
      "明確邊界"
    ],
    [
      "處理",
      "附件建議",
      "V5.1 的決定"
    ],
    [
      "術語",
      "本文件固定含義"
    ],
    [
      "角色",
      "負責什麼",
      "不得自行做什麼"
    ],
    [
      "設計",
      "BW 使用位置",
      "減少 token 的來源",
      "建議"
    ],
    [
      "責任位置",
      "V5.1 必交內容"
    ],
    [
      "資料",
      "候選實體位置"
    ],
    [
      "資料類型",
      "可否缺失／重建",
      "生命週期與失效"
    ],
    [
      "資訊",
      "用途"
    ],
    [
      "資訊缺口",
      "優先處理方式"
    ],
    [
      "選項",
      "BW 的適合位置",
      "V5.1 決定"
    ],
    [
      "附件",
      "本輪重點與處理"
    ],
    [
      "階段",
      "核心問題",
      "應交付的結果"
    ],
    [
      "面向",
      "要確認什麼",
      "BW 範例"
    ],
    [
      "項目",
      "建議"
    ],
    [
      "項目",
      "決定",
      "理由"
    ],
    [
      "類別",
      "必要內容"
    ],
    [
      "類型",
      "使用者表達",
      "適合的處理"
    ]
  ];
  // Closed projection grammar: column-zero tables separated by blank lines,
  // standalone comments, and closed fences. This is not a Markdown renderer.
  // Preserve all outer fragments; escaped trailing pipes cannot be discarded.
  const pipeParts = line => {
    const parts = [];
    let start = 0, slashes = 0;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === "|" && slashes % 2 === 0) {
        parts.push(line.slice(start, i));
        start = i + 1;
      }
      slashes = char === "\\" ? slashes + 1 : 0;
    }
    parts.push(line.slice(start));
    return parts;
  };
  const decode = cell => cell.replace(/^[ \t]+|[ \t]+$/g, "").replaceAll("\\|", "|");
  const blank = line => /^[ \t]*$/.test(line);
  const cells = (line, message) => {
    const parts = pipeParts(line.replace(/[ \t]+$/, ""));
    assert.ok(parts.length >= 3 && parts[0] === "" && parts.at(-1) === "", message);
    return parts.slice(1, -1).map(decode);
  };
  const lines = planText.split(/\r?\n/);
  const visible = Array(lines.length).fill(false);
  // Only complete, same-line code spans may quote HTML-like text. Escapes
  // apply outside code; a closing backtick run must match the opening width.
  // The closed grammar rejects multiline spans and ambiguous link/autolink
  // prefixes before quoted HTML. Raw prefixes include earlier code contents:
  // guessing that an earlier delimiter was code must not erase that context.
  const hasRawHtmlOutsideInlineCode = (line, paragraphPrefix) => {
    const escaped = index => {
      let slashes = 0;
      for (let i = index - 1; i >= 0 && line[i] === "\\"; i--) slashes++;
      return slashes % 2 === 1;
    };
    const runEnd = index => {
      while (line[index] === "`") index++;
      return index;
    };
    for (let i = 0; i < line.length;) {
      if (line[i] === "`" && !escaped(i)) {
        const end = runEnd(i), width = end - i;
        let close = -1;
        for (let j = end; j < line.length;) {
          if (line[j] !== "`") { j++; continue; }
          const run = runEnd(j);
          if (run - j === width) { close = j; break; }
          j = run;
        }
        assert.ok(close >= 0, "plan incomplete inline code unsupported");
        if (/<[A-Za-z/!?]/.test(line.slice(end, close))) {
          const prefix = paragraphPrefix + line.slice(0, i);
          assert.ok(!/[\[\]@]|:\/\/|www\./i.test(prefix), "plan ambiguous inline context unsupported");
        }
        i = close + width;
        continue;
      }
      // Keep the existing closed grammar's conservative HTML-like prefix
      // rejection, including declarations and processing instructions.
      if (line[i] === "<" && !escaped(i) && /^<[A-Za-z/!?]/.test(line.slice(i))) return true;
      i++;
    }
    return false;
  };
  let fence = null, comment = false, paragraphPrefix = "";
  const consumeComment = text => {
    const end = text.indexOf("-->");
    const content = end < 0 ? text : text.slice(0, end);
    assert.ok(!content.includes("<!--"), "plan nested HTML comment unsupported");
    if (end < 0) return true;
    assert.ok(blank(text.slice(end + 3)), "plan HTML comment position unsupported");
    return false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence !== null) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && /^[ \t]*$/.test(marker[2])) fence = null;
      continue;
    }
    if (comment) {
      comment = consumeComment(line);
      continue;
    }
    if (marker) {
      // Indented openers may belong to a list container that later ends at
      // column zero. Only unambiguous top-level fences may mask source rows.
      assert.ok(line[0] === marker[1][0] && (i === 0 || blank(lines[i - 1])),
        "plan fence container or indentation unsupported");
      assert.ok(marker[1][0] !== "`" || !marker[2].includes("`"), "plan backtick fence info unsupported");
      fence = { char: marker[1][0], length: marker[1].length };
      continue;
    }
    assert.ok(!/^[ \t]+(?:`{3,}|~{3,})/.test(line),
      "plan fence container or indentation unsupported");
    const open = line.indexOf("<!--");
    if (open >= 0) {
      assert.ok(/^ {0,3}$/.test(line.slice(0, open)), "plan HTML comment position unsupported");
      comment = consumeComment(line.slice(open + 4));
      continue;
    }
    assert.ok(!line.includes("-->"), "plan HTML comment position unsupported");
    if (blank(line)) paragraphPrefix = "";
    // Column-zero table candidates are checked by cell after framing and
    // width validation below. Never apply whole-line code spans to them.
    if (!line.startsWith("|"))
      assert.ok(!hasRawHtmlOutsideInlineCode(line, paragraphPrefix), "plan raw HTML block unsupported");
    if (!blank(line)) paragraphPrefix += line + "\n";
    visible[i] = true;
  }
  assert.ok(fence === null && !comment, "plan unterminated block unsupported");
  const rows = [], consumed = Array(lines.length).fill(false);
  const sameCells = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const structuralPipe = line => {
    let slashes = 0;
    for (let i = 0; i < line.length;) {
      const char = line[i];
      if (char === "`" && slashes % 2 === 0) {
        let end = i;
        while (line[end] === "`") end++;
        const width = end - i;
        let close = -1;
        for (let j = end; j < line.length;) {
          if (line[j] !== "`") { j++; continue; }
          let run = j;
          while (line[run] === "`") run++;
          if (run - j === width) { close = run; break; }
          j = run;
        }
        assert.ok(close >= 0, "plan incomplete inline code unsupported");
        i = close; slashes = 0; continue;
      }
      if (char === "|" && slashes % 2 === 0) return true;
      slashes = char === "\\" ? slashes + 1 : 0;
      i++;
    }
    return false;
  };
  const separatorCandidate = (line, preceding) => {
    const raw = pipeParts(line), parts = raw.map(decode);
    if (parts[0] === "") parts.shift();
    if (parts.at(-1) === "") parts.pop();
    // A delimiter-shaped fragment is enough to demand strict validation.
    // Malformed trailing fragments must not erase the candidate.
    return parts.length > 0 && parts.some(cell => /^:?-+:?$/.test(cell))
      && (raw.length > 1 || structuralPipe(preceding));
  };
  let tables = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!visible[i] || visible[i + 1] !== true ||
      !separatorCandidate(lines[i + 1], lines[i])) continue;
    assert.ok(i === 0 || blank(lines[i - 1]), "plan table header format drift");
    const columns = cells(lines[i], "plan table header format drift");
    const separator = cells(lines[i + 1], "plan table separator drift");
    const requirement = sameCells(columns, header);
    assert.ok(requirement || (columns.length !== fields.length && otherHeaders.some(other => sameCells(columns, other))), "plan table header format drift");
    assert.ok(separator.length === columns.length && separator.every(cell => /^:?-+:?$/.test(cell)), "plan table separator drift");
    if (requirement) tables++;
    consumed[i] = consumed[i + 1] = true;
    for (i += 2; i < lines.length && !blank(lines[i]); i++) {
      const message = requirement ? `plan leaf${pipeParts(lines[i])[1]?.trim() ?? "unknown"} row shape drift` : "plan ordinary table row shape drift";
      assert.ok(visible[i] === true, message);
      const row = cells(lines[i], message);
      assert.equal(row.length, columns.length, message);
      // GFM pipes remain structural inside backtick spans. Check raw cells
      // before escaped-pipe decoding; code and link context stay in one cell.
      for (const cell of pipeParts(lines[i]).slice(1, -1))
        assert.ok(!hasRawHtmlOutsideInlineCode(cell, ""), "plan raw HTML block unsupported");
      consumed[i] = true;
      if (requirement) rows.push(row);
    }
    i--;
  }
  for (let i = 0; i < lines.length; i++)
    if (visible[i] && !consumed[i]) assert.ok(!structuralPipe(lines[i]), "plan unconsumed structural pipe unsupported");
  assert.ok(tables > 0, "plan requirement tables missing");
  assert.deepEqual(rows.map(row => row[0]).sort(), requirements.rows.map(row => row.id).sort(), "plan row identity drift");
  const expectedRows = new Map(requirements.rows.map(row => [row.id, row]));
  for (const actual of rows) {
    const expected = expectedRows.get(actual[0]);
    assert.equal(actual.length, fields.length, `plan leaf${expected.id} row shape drift`);
    for (let j = 0; j < fields.length; j++)
      assert.equal(actual[j], expected[fields[j]], `plan leaf${expected.id} ${fields[j]} drift`);
  }
  return { rows: rows.length, fields: fields.length };
}

export function validateV51Catalog(requirements, backlog) {
  const rowMap = validatedRequirementsContext(requirements, backlog?.developmentBase, requirements?.sourceDigest);
  const leaves = requirements.rows.filter(row => row.category !== "彙總");
  exact(backlog, BACKLOG_ROOT_FIELDS, "backlog root");
  assert.equal(backlog.schemaVersion, 1);
  for (const key of ["kind", "sourceRepository", "sourceNumberNamespace"]) text(backlog[key], "backlog " + key);
  assert.ok(Array.isArray(backlog.tasks), "backlog tasks must be an array");
  for (const task of backlog.tasks) validateTaskShape(task);
  const tasks = new Map(backlog.tasks.map(task => [task.code, task]));
  assert.equal(tasks.size, backlog.tasks.length, "duplicate task code");
  const owners = new Map();
  const numbers = new Set();
  for (const task of tasks.values()) {
    assert.ok(["R", "W", "Q"].includes(task.owner));
    assert.ok(["READY", "BLOCKED", "UNTRIGGERED"].includes(task.state));
    assert.ok(["V5.0", "V5.1"].includes(task.version));
    assert.equal(new Set(task.requirements).size, task.requirements.length);
    for (const id of task.requirements) assert.ok(rowMap.has(id) && rowMap.get(id).category !== "彙總", "invalid leaf " + id);
    for (const dependency of task.dependencies) assert.ok(tasks.has(dependency), "missing dependency " + dependency);
    assert.ok(task.contract && typeof task.contract === "object" && !Array.isArray(task.contract), "planning contract missing");
    const localeTask = /^RC2-L(12|14|13)$/.test(task.code);
    assert.deepEqual(Object.keys(task.contract).sort(), [...CONTRACT_KEYS, ...(localeTask ? ["localeIds", "provenance"] : [])].sort(),
      "unknown or missing planning contract field");
    for (const field of ["reservedPaths", "beforeWrite", "forbidden"])
      assert.ok(Array.isArray(task.contract[field]) && task.contract[field].length > 0
        && task.contract[field].every(value => typeof value === "string" && value.trim()), "invalid planning contract " + field);
    assert.ok(task.contract.compatibility === null || typeof task.contract.compatibility === "string", "invalid compatibility");
    if (localeTask) {
      assert.deepEqual(task.contract.localeIds, task.localeIds, "locale contract mismatch");
      assert.equal(task.contract.localeIds.length, Number(task.code.slice(5)), "locale count mismatch");
      assert.ok(typeof task.contract.provenance === "string" && task.contract.provenance.trim(), "locale provenance missing");
    }
    const digest = createHash("sha256").update(JSON.stringify(canonical(task.contract))).digest("hex");
    assert.equal(digest, task.contractDigest, "contract digest drift " + task.code);
    assert.equal(task.contract.code, task.code, "contract code mismatch");
    assert.equal(task.contract.base, backlog.developmentBase, "contract base mismatch");
    assert.equal(task.contract.owner, task.owner, "contract owner mismatch");
    assert.deepEqual(task.contract.reservedPaths, task.reservedPaths, "contract paths mismatch");
    const categories = task.requirements.map(id => rowMap.get(id).category);
    if (categories.includes("研究")) assert.equal(task.state, "UNTRIGGERED", "P1 remains outside this execution");
    if (task.state === "READY") {
      validateV51DispatchPacket(task, task.dispatchPacket, backlog.developmentBase, requirements.sourceDigest, requirements);
      assert.ok(Object.hasOwn(REVIEWED_READY_PACKET_DIGESTS, task.code), "READY requires a reviewed dispatch packet baseline");
      assert.equal(task.dispatchPacket.packetDigest, REVIEWED_READY_PACKET_DIGESTS[task.code], "reviewed dispatch packet drift");
    }
    if (task.issueNumber !== null) {
      assert.ok(Number.isSafeInteger(task.issueNumber) && task.issueNumber > 0);
      assert.ok(!numbers.has(task.issueNumber), "duplicate issue number");
      numbers.add(task.issueNumber);
    }
    if (task.owner !== "R") for (const path of task.reservedPaths) {
      const reserved = portablePathKey(path, "unsafe reserved path");
      for (const previous of owners.keys()) assert.ok(previous !== reserved
        && !previous.startsWith(reserved + "/") && !reserved.startsWith(previous + "/"), "overlapping worker scope " + reserved);
      owners.set(reserved, task.code);
    }
  }
  for (const row of leaves) {
    const actual = [...tasks.values()].filter(task => task.requirements.includes(row.id)).map(task => task.code);
    assert.ok(actual.length, "uncovered leaf " + row.id);
    assert.deepEqual(requirements.coverage[row.id], actual, "coverage drift " + row.id);
  }
  const done = new Set();
  function visit(code, active) {
    assert.ok(!active.has(code), "dependency cycle " + code);
    if (done.has(code)) return;
    const next = new Set(active).add(code);
    for (const dependency of tasks.get(code).dependencies) visit(dependency, next);
    done.add(code);
  }
  for (const code of tasks.keys()) visit(code, new Set());
  assert.equal(tasks.size, 129, "reviewed task count drift");
  const localeGroups = [...tasks.values()].filter(task => Array.isArray(task.localeIds))
    .map(task => [task.code, task.localeIds.length]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  assert.deepEqual(localeGroups, [["RC2-L12", 12], ["RC2-L13", 13], ["RC2-L14", 14]], "reviewed RC2 locale group sizes drift");
  const localeIds = [...tasks.values()].flatMap(task => task.localeIds ?? []);
  assert.equal(localeIds.length, 39, "reviewed RC2 locale count drift");
  assert.equal(new Set(localeIds).size, 39, "RC2 locale IDs must remain globally unique");
  const metadata = {
    kind: backlog.kind, schemaVersion: backlog.schemaVersion, developmentBase: backlog.developmentBase,
    sourceNumberNamespace: backlog.sourceNumberNamespace, sourceRepository: backlog.sourceRepository,
    tasks: backlog.tasks.map(task => Object.fromEntries(IMMUTABLE_TASK_FIELDS
      .filter(key => Object.hasOwn(task, key)).map(key => [key, task[key]])))
      .sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
  };
  assert.equal(hash(metadata), REVIEWED_BACKLOG_METADATA_DIGEST, "reviewed backlog metadata drift");
  return { tasks: tasks.size, leaf: leaves.length, counts: requirements.counts, mappedIssues: numbers.size };
}

function validateTaskShape(task) {
  assert.ok(task && typeof task === "object" && !Array.isArray(task), "task record must be an object");
  const localeTask = typeof task.code === "string" && /^RC2-L(12|14|13)$/.test(task.code);
  exact(task, [...TASK_REQUIRED_FIELDS, ...(localeTask ? ["localeIds"] : []),
    ...TASK_OPTIONAL_FIELDS.filter(key => Object.hasOwn(task, key))], "task record");
  text(task.code, "task code"); text(task.title, "task title");
  assert.equal(typeof task.detail, "string", "task detail must be a string");
  if (Object.hasOwn(task, "readOnlyInspectionAllowed"))
    assert.equal(typeof task.readOnlyInspectionAllowed, "boolean", "task readOnlyInspectionAllowed must be boolean");
  if (Object.hasOwn(task, "readinessBlocker")) text(task.readinessBlocker, "task readinessBlocker");
  if (Object.hasOwn(task, "dispatchPacket"))
    assert.ok(task.dispatchPacket && typeof task.dispatchPacket === "object" && !Array.isArray(task.dispatchPacket),
      "task dispatchPacket must be an object");
}

function hash(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function exact(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label + " must be an object");
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), label + " has unknown or missing field");
}
function text(value, label) { assert.ok(typeof value === "string" && value.trim(), label + " missing"); }
function strings(value, label) {
  assert.ok(Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string" && item.trim()), label + " missing");
}
function timestamp(value, label) {
  assert.ok(typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, label + " must be an ISO UTC timestamp");
}
function sha256(value, label) { assert.ok(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), label + " invalid"); }
// Conservative lexical identity for unknown/cross-platform hosts. This is an
// ASCII path contract, not a Unicode filesystem equivalence implementation.
// Preserve the original spelling in records; fold only the comparison key.
// Physical symlink/hardlink/short-name identity remains Root admission work.
function portablePathKey(value, label) {
  assert.ok(typeof value === "string" && /^[A-Za-z0-9._/-]+$/.test(value),
    label + ": portable ASCII repository path required");
  const parts = value.split("/");
  assert.ok(parts.every(part => part && part !== "." && part !== ".." && !part.endsWith(".")
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
    label + ": invalid or platform-aliased component");
  return value.toLowerCase();
}
// Entry criteria are frozen planning semantics, not adoption/outcome criteria.
const CONDITIONAL_CRITERIA = Object.freeze({
  "34": "storage-hotspot-v1",
  "36b": "track-r-entry-v1", "37": "track-r-entry-v1", "38": "track-r-entry-v1",
  "39": "track-r-entry-v1", "40": "track-r-entry-v1", "41": "track-r-entry-v1",
  "42": "track-r-entry-v1", "43": "track-r-entry-v1"
});

function validateConditionalTrigger(packet, rows, base, sourceDigest) {
  const trigger = packet.conditionalTrigger;
  exact(trigger, ["evaluatedAt", "bindings"], "conditional trigger");
  timestamp(trigger.evaluatedAt, "conditional trigger evaluation");
  const evaluatedMs = Date.parse(trigger.evaluatedAt);
  assert.ok(evaluatedMs < Date.parse(packet.workspaceLease.expiresAt) && evaluatedMs < Date.parse(packet.budget.deadline),
    "conditional trigger snapshot must precede lease and budget expiry");
  assert.ok(Array.isArray(trigger.bindings), "conditional trigger bindings missing");
  const ids = trigger.bindings.map(binding => binding?.leafId);
  assert.equal(new Set(ids).size, ids.length, "duplicate conditional trigger leaf");
  assert.deepEqual([...ids].sort(), rows.map(row => row.id).sort(), "conditional trigger leaves mismatch");
  for (const binding of trigger.bindings) {
    exact(binding, ["leafId", "rowDigest", "criterionId", "evidenceDigest", "sourceDigest", "base", "policyDigest", "observedAt", "expiresAt"], "conditional trigger binding");
    const row = rows.find(row => row.id === binding.leafId);
    sha256(binding.rowDigest, "conditional trigger row digest");
    assert.equal(binding.rowDigest, hash(row), "conditional trigger row mismatch");
    assert.equal(binding.criterionId, CONDITIONAL_CRITERIA[row.id], "conditional trigger criterion mismatch");
    sha256(binding.evidenceDigest, "conditional trigger evidence digest");
    assert.equal(binding.sourceDigest, sourceDigest, "conditional trigger source mismatch");
    assert.equal(binding.base, base, "conditional trigger base mismatch");
    sha256(binding.policyDigest, "conditional trigger policy digest");
    assert.equal(binding.policyDigest, packet.contractDetails.policyBinding.digest, "conditional trigger policy mismatch");
    timestamp(binding.observedAt, "conditional trigger observation");
    timestamp(binding.expiresAt, "conditional trigger expiry");
    assert.ok(Date.parse(binding.observedAt) <= evaluatedMs && evaluatedMs < Date.parse(binding.expiresAt),
      "conditional trigger observation is not current at evaluation");
  }
}

// Structural validation only; this export does not establish catalog READY.
export function validateV51DispatchPacket(task, packet, base, sourceDigest, requirements) {
  const rowMap = validatedRequirementsContext(requirements, base, sourceDigest);
  assert.ok(Array.isArray(task.requirements) && new Set(task.requirements).size === task.requirements.length, "dispatch task requirements invalid");
  const rows = task.requirements.map(id => {
    const row = rowMap.get(id);
    assert.ok(row && row.category !== "彙總", "invalid dispatch leaf " + id);
    assert.notEqual(row.category, "研究", "P1 remains outside this execution");
    return row;
  });
  const conditionalRows = rows.filter(row => row.category === "條件");
  assert.ok(packet && packet.schemaVersion === 2, "READY needs a frozen dispatch packet");
  exact(packet, ["schemaVersion", "issue", "owner", "integrationOwner", "reviewers", "sourceDigest", "base", "contractDigest",
    "contractDetails", "reservedPaths", "workspaceLease", "environment", "acceptance", "budget", "stopConditions", "rollback",
    "lifecycle", "dependencyReceipts", "packetDigest", ...(conditionalRows.length ? ["conditionalTrigger"] : [])], "dispatch packet");
  assert.equal(packet.issue, task.code, "dispatch issue mismatch");
  exact(packet.owner, ["id", "role"], "dispatch owner"); text(packet.owner.id, "dispatch owner ID");
  assert.equal(packet.owner.role, task.owner, "dispatch owner role mismatch");
  exact(packet.integrationOwner, ["id", "role"], "dispatch integration owner"); text(packet.integrationOwner.id, "dispatch integration owner ID");
  assert.equal(packet.integrationOwner.role, "R", "dispatch integration owner must be Root");
  assert.ok(Array.isArray(packet.reviewers) && packet.reviewers.length > 0, "dispatch reviewer missing");
  const reviewerIds = new Set();
  for (const reviewer of packet.reviewers) {
    exact(reviewer, ["id", "role"], "dispatch reviewer"); text(reviewer.id, "dispatch reviewer ID");
    assert.ok(["R", "W", "Q"].includes(reviewer.role), "invalid dispatch reviewer role");
    assert.ok(reviewer.id !== packet.owner.id && !reviewerIds.has(reviewer.id), "dispatch reviewer must be distinct"); reviewerIds.add(reviewer.id);
  }
  assert.equal(packet.sourceDigest, sourceDigest, "dispatch source mismatch");
  assert.equal(packet.base, base, "dispatch base mismatch");
  assert.equal(packet.contractDigest, task.contractDigest, "dispatch contract mismatch");
  assert.deepEqual(packet.reservedPaths, task.reservedPaths, "dispatch paths mismatch");
  if (task.owner !== "R") {
    const writePaths = [];
    for (const path of packet.reservedPaths) {
      const key = portablePathKey(path, "unsafe reserved path");
      assert.ok(writePaths.every(previous => previous !== key && !previous.startsWith(key + "/")
        && !key.startsWith(previous + "/")), "overlapping worker scope " + path);
      writePaths.push(key);
    }
  }
  const details = packet.contractDetails;
  exact(details, ["schema", "exports", "errors", "callbacks", "bytes", "storage", "sourceBinding", "policyBinding"], "dispatch contract details");
  for (const key of ["schema", "exports", "errors", "callbacks", "bytes", "storage"]) text(details[key], "dispatch contract " + key);
  exact(details.sourceBinding, ["base", "head", "files"], "dispatch contract source binding");
  assert.equal(details.sourceBinding.base, base, "dispatch source binding base mismatch");
  assert.equal(details.sourceBinding.head, base, "dispatch source binding head mismatch");
  assert.ok(Array.isArray(details.sourceBinding.files) && details.sourceBinding.files.length > 0, "dispatch source files missing");
  const filePaths = new Set();
  for (const file of details.sourceBinding.files) {
    exact(file, ["path", "status", "sha256"], "dispatch source file"); text(file.path, "dispatch source path");
    const fileKey = portablePathKey(file.path, "unsafe dispatch source path");
    assert.ok(!filePaths.has(fileKey), "duplicate dispatch source path"); filePaths.add(fileKey);
    assert.ok(["PRESENT", "ABSENT"].includes(file.status), "invalid dispatch source file status");
    if (file.status === "PRESENT") sha256(file.sha256, "dispatch source file digest"); else assert.equal(file.sha256, null, "absent source must have null digest");
  }
  exact(details.policyBinding, ["id", "digest"], "dispatch contract policy binding"); text(details.policyBinding.id, "dispatch policy ID");
  sha256(details.policyBinding.digest, "dispatch policy digest");
  exact(packet.workspaceLease, ["id", "ownerId", "branch", "worktreePath", "expiresAt"], "dispatch workspace lease");
  for (const key of ["id", "branch", "worktreePath"]) text(packet.workspaceLease[key], "dispatch workspace lease " + key);
  assert.ok(packet.workspaceLease.branch.startsWith("codex/"), "dispatch branch must use codex prefix");
  assert.equal(packet.workspaceLease.ownerId, packet.owner.id, "dispatch lease owner mismatch"); timestamp(packet.workspaceLease.expiresAt, "dispatch lease expiry");
  exact(packet.environment, ["host", "nodeVersion", "toolVersions"], "dispatch environment");
  exact(packet.environment.host, ["os", "arch"], "dispatch host"); text(packet.environment.host.os, "dispatch host OS"); text(packet.environment.host.arch, "dispatch host architecture");
  assert.ok(typeof packet.environment.nodeVersion === "string" && /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(packet.environment.nodeVersion), "dispatch Node version missing");
  const tools = packet.environment.toolVersions;
  assert.ok(tools && typeof tools === "object" && !Array.isArray(tools) && Object.keys(tools).length > 0, "dispatch tool versions missing");
  for (const [tool, version] of Object.entries(tools)) { assert.ok(/^[A-Za-z0-9_.+-]+$/.test(tool), "invalid dispatch tool name"); text(version, "dispatch tool version"); }
  exact(packet.acceptance, ["commands", "positiveCases", "negativeCases", "compatibility"], "dispatch acceptance");
  for (const key of ["commands", "positiveCases", "negativeCases"]) strings(packet.acceptance[key], "dispatch acceptance " + key);
  assert.ok(packet.acceptance.compatibility === null || typeof packet.acceptance.compatibility === "string", "invalid dispatch compatibility");
  assert.equal(packet.acceptance.compatibility, task.contract.compatibility, "dispatch compatibility mismatch");
  exact(packet.budget, ["attempts", "deadline", "tokenBudget", "unknownTokens", "noProgressLimit"], "dispatch budget");
  assert.ok(Number.isSafeInteger(packet.budget.attempts) && packet.budget.attempts > 0, "invalid dispatch attempt budget"); timestamp(packet.budget.deadline, "dispatch deadline");
  assert.ok(packet.budget.tokenBudget === null || (Number.isSafeInteger(packet.budget.tokenBudget) && packet.budget.tokenBudget > 0), "invalid dispatch token budget");
  assert.ok(["STOP", "BOUND_BY_ATTEMPTS_AND_DEADLINE"].includes(packet.budget.unknownTokens), "invalid unknown token rule");
  assert.equal(packet.budget.noProgressLimit, 2, "dispatch no-progress limit must remain two"); strings(packet.stopConditions, "dispatch stop conditions");
  exact(packet.rollback, ["trigger", "procedure"], "dispatch rollback"); text(packet.rollback.trigger, "dispatch rollback trigger"); text(packet.rollback.procedure, "dispatch rollback procedure");
  exact(packet.lifecycle, ["ownerId", "recordPidPpidDescendants", "recordCwd", "recordPortsSockets", "cleanupMethod"], "dispatch lifecycle");
  assert.equal(packet.lifecycle.ownerId, packet.owner.id, "dispatch lifecycle owner mismatch");
  for (const key of ["recordPidPpidDescendants", "recordCwd", "recordPortsSockets"]) assert.equal(packet.lifecycle[key], true, "dispatch lifecycle must record " + key);
  text(packet.lifecycle.cleanupMethod, "dispatch lifecycle cleanup method");
  assert.ok(Array.isArray(packet.dependencyReceipts), "dispatch dependency receipts missing");
  const receiptTasks = packet.dependencyReceipts.map(receipt => receipt?.task);
  assert.equal(new Set(receiptTasks).size, receiptTasks.length, "duplicate dispatch dependency receipt");
  assert.deepEqual([...receiptTasks].sort(), [...task.dependencies].sort(), "dispatch dependency receipts mismatch");
  for (const receipt of packet.dependencyReceipts) {
    exact(receipt, ["task", "sourceDigest", "base", "receiptDigest"], "dispatch dependency receipt");
    assert.equal(receipt.base, base, "dispatch dependency receipt base mismatch"); assert.equal(receipt.sourceDigest, sourceDigest, "dispatch dependency receipt source mismatch");
    sha256(receipt.receiptDigest, "dispatch dependency receipt digest");
  }
  if (conditionalRows.length) validateConditionalTrigger(packet, conditionalRows, base, sourceDigest);
  const unsigned = Object.fromEntries(Object.entries(packet).filter(([key]) => key !== "packetDigest"));
  assert.equal(packet.packetDigest, hash(unsigned), "dispatch packet digest drift");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = new URL("../docs/plans/", import.meta.url);
  const [requirements, backlog] = await Promise.all(["v5-1-requirements.json", "v5-1-backlog.json"]
    .map(async name => JSON.parse(await readFile(new URL(name, base), "utf8"))));
  const result = validateV51Catalog(requirements, backlog);
  validateV51PlanProjection(requirements, await readFile(new URL("v5-1.md", base), "utf8"));
  console.log(JSON.stringify(result, null, 2));
}
