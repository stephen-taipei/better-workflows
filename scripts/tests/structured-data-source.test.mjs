import assert from "node:assert/strict";
import test from "node:test";
import { readStructuredDataArray, readStructuredDataObject, readStructuredLiteralArray, readStructuredLiteralObject } from "../structured-data-source.mjs";

test("array-root documentation data is read without running the surrounding program", () => {
  const marker = "const scenes = ";
  const source = "throw new Error('must not execute'); " + marker + "[{no:'01',records:[{id:'demo-1'}]},'two',]; fetch('/forbidden');";
  const result = readStructuredDataArray(source, marker);
  assert.equal(result.value[0].records[0].id, "demo-1");
  assert.equal(result.value[1], "two");
  assert.equal(source.slice(result.start, result.end), marker + "[{no:'01',records:[{id:'demo-1'}]},'two',];");
  assert.throws(() => readStructuredDataObject(source, marker), /root must be an object/);
  assert.throws(() => readStructuredDataArray(marker + "{};", marker), /root must be an array/);
});

test("array reader keeps expression, prototype, duplicate, complexity and type boundaries", () => {
  for (const body of [
    "[run()]", "[...other]", "[{get value(){return 'x'}}]", "[new Array()]", "[`template`]",
    "[1]", "[true]", "[null]", "[undefined]", "[,'hole']", "[{id:'x',id:'y'}]",
    "[{__proto__:'x'}]", "[{constructor:'x'}]", "[{prototype:'x'}]", "['\\z']", "['\\ud800']",
    "['unterminated]", "[] || []", "[].map(run)", "[".repeat(18) + "'x'" + "]".repeat(18)
  ]) assert.throws(() => readStructuredDataArray("const data = " + body + ";", "const data = "), /Structured data source:/, body);
  assert.throws(() => readStructuredDataArray("const data = []; const data = [];", "const data = "), /one literal marker/);
  assert.throws(() => readStructuredDataArray("const data = " + " ".repeat(2 * 1024 * 1024) + "[];", "const data = "), /source size/);
});

test("opt-in guide readers accept integer counters and null without evaluating surrounding code", () => {
  const marker = "const guide = ";
  const literal = "{modes:[{level:1,selector:null}, {level:4,selector:'critical'}],count:34,delta:-2,zero:0};";
  const source = "throw new Error('do not execute'); " + marker + literal + " fetch('/do-not-call');";
  const result = readStructuredLiteralObject(source, marker);
  assert.equal(result.value.modes[0].level, 1);
  assert.equal(result.value.modes[0].selector, null);
  assert.equal(result.value.modes[1].selector, "critical");
  assert.equal(result.value.count, 34);
  assert.equal(result.value.delta, -2);
  assert.equal(result.value.zero, 0);
  assert.equal(Object.getPrototypeOf(result.value), null);
  assert.equal(source.slice(result.start, result.end), marker + literal);
  assert.deepEqual(readStructuredLiteralArray("const data = [0,-2,9007199254740991,null,'null'];", "const data = ").value, [0,-2,9007199254740991,null,"null"]);
  assert.throws(() => readStructuredDataObject(source, marker), /only literal/);
  assert.throws(() => readStructuredDataArray("const data = [1,null];", "const data = "), /only literal/);
});

test("opt-in guide readers reject scalar extensions, ambiguous numbers and executable grammar", () => {
  for (const body of [
    "[true]", "[false]", "[undefined]", "[NaN]", "[Infinity]", "[-Infinity]", "[1.2]", "[1e2]",
    "[0x10]", "[0b10]", "[01]", "[+1]", "[-0]", "[1_000]", "[2n]", "[9007199254740992]",
    "[-9007199254740992]", "[1+2]", "[nullish]", "[null.value]", "[run()]", "[...other]",
    "[{get value(){return 1}}]", "[{id:1,id:2}]", "[{__proto__:null}]", "[{constructor:1}]",
    "[{prototype:null}]", "[new Array()]", "[`template`]", "[,1]", "[1] || []", "[1].map(run)",
    "Object.freeze([1])", "[".repeat(18) + "1" + "]".repeat(18)
  ]) assert.throws(() => readStructuredLiteralArray("const data = " + body + ";", "const data = "), /Structured data source:/, body);
  assert.throws(() => readStructuredLiteralArray("const data = null;", "const data = "), /root must be an array/);
  assert.throws(() => readStructuredLiteralObject("const data = [];", "const data = "), /root must be an object/);
  assert.throws(() => readStructuredLiteralArray("const data = [1]; const data = [];", "const data = "), /one literal marker/);
  assert.throws(() => readStructuredLiteralArray("const data = [" + "1,".repeat(20001) + "];", "const data = "), /data complexity/);
  assert.throws(() => readStructuredLiteralArray("const data = " + " ".repeat(2 * 1024 * 1024) + "[];", "const data = "), /source size/);
});
