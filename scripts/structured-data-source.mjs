// A bounded literal-data reader for interactive documentation catalogs.
// It never evaluates JavaScript; calls, expressions, accessors and spreads fail.
function readStructuredData(source, marker, root, literalScalars = false) {
  const fail = (message) => { throw new Error(`Structured data source: ${message}`); };
  if (typeof source !== "string" || source.length > 2 * 1024 * 1024) fail("source size");
  if (typeof marker !== "string" || !marker.length) fail("missing marker");
  const start = source.indexOf(marker);
  if (start < 0 || source.indexOf(marker, start + marker.length) !== -1) fail("expected one literal marker");
  let cursor = start + marker.length, nodes = 0;
  const whitespace = () => { while (cursor < source.length && /\s/.test(source[cursor])) cursor++; };
  const string = () => {
    const quote = source[cursor++];
    let result = "";
    while (cursor < source.length) {
      const char = source[cursor++];
      if (char === quote) {
        if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(result)) fail("unpaired surrogate");
        return result;
      }
      if (char.charCodeAt(0) < 32) fail("unescaped control in string");
      if (char !== "\\") { result += char; continue; }
      const escaped = source[cursor++];
      const simple = { "'": "'", '"': '"', "\\": "\\", "/": "/", n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
      if (Object.hasOwn(simple, escaped)) { result += simple[escaped]; continue; }
      if (escaped === "u" || escaped === "x") {
        const width = escaped === "u" ? 4 : 2;
        const hex = source.slice(cursor, cursor + width);
        if (!new RegExp(`^[a-fA-F0-9]{${width}}$`).test(hex)) fail("invalid string escape");
        result += String.fromCharCode(Number.parseInt(hex, 16)); cursor += width; continue;
      }
      fail("unsupported string escape");
    }
    fail("unterminated string");
  };
  const value = (depth) => {
    if (++nodes > 20000 || depth > 16) fail("data complexity");
    whitespace();
    const char = source[cursor];
    if (char === '"' || char === "'") return string();
    // Separate opt-in readers support the integer counters and null selectors
    // present in the pinned long-form guides. Existing string-only readers
    // retain their original boundary. This is literal parsing, never evaluation.
    if (literalScalars && source.startsWith("null", cursor)) {
      cursor += 4;
      return null;
    }
    if (literalScalars && /[-0-9]/.test(char || "")) {
      const match = /^-?(?:0|[1-9][0-9]*)/.exec(source.slice(cursor));
      if (!match) fail("invalid integer literal");
      const number = Number(match[0]);
      if (!Number.isSafeInteger(number) || Object.is(number, -0)) fail("unsafe integer literal");
      cursor += match[0].length;
      return number;
    }
    if (char !== "{" && char !== "[") fail("only literal objects, arrays and strings are accepted");
    const array = char === "[", end = array ? "]" : "}", result = array ? [] : Object.create(null);
    cursor++; whitespace();
    while (source[cursor] !== end) {
      if (cursor >= source.length) fail("unterminated collection");
      if (array) result.push(value(depth + 1));
      else {
        let key;
        if (source[cursor] === '"' || source[cursor] === "'") key = string();
        else {
          const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(cursor));
          if (!match) fail("invalid object key");
          key = match[0]; cursor += key.length;
        }
        if (["__proto__", "prototype", "constructor"].includes(key) || Object.hasOwn(result, key)) fail("duplicate or reserved key");
        whitespace();
        if (source[cursor++] !== ":") fail("missing colon");
        result[key] = value(depth + 1);
      }
      whitespace();
      if (source[cursor] === end) break;
      if (source[cursor++] !== ",") fail("missing comma");
      whitespace();
    }
    cursor++;
    return result;
  };
  whitespace();
  if (source[cursor] !== (root === "object" ? "{" : "[")) fail(`root must be an ${root}`);
  const result = value(0);
  whitespace();
  if (source[cursor] !== ";") fail("literal must end with a semicolon");
  return { value: result, start, end: cursor + 1 };
}

export const readStructuredDataObject = (source, marker) => readStructuredData(source, marker, "object");
export const readStructuredDataArray = (source, marker) => readStructuredData(source, marker, "array");

// Only object/array roots are accepted; booleans, floats, bigint, expressions,
// calls and executable Object.freeze wrappers remain outside this grammar.
export const readStructuredLiteralObject = (source, marker) => readStructuredData(source, marker, "object", true);
export const readStructuredLiteralArray = (source, marker) => readStructuredData(source, marker, "array", true);
