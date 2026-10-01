// Closed parsers for pinned documentation sources, not general JavaScript or HTML.
// Never execute a documentation script to obtain its translation dictionary.
const fail = (message) => { throw new Error(`HTML source: ${message}`); };

export function readDataObject(source, marker = "const messages = ") {
  const start = source.indexOf(marker);
  if (start < 0 || source.indexOf(marker, start + marker.length) !== -1) fail("expected one data-object marker");
  let cursor = start + marker.length;
  const whitespace = () => { while (/\s/.test(source[cursor] || "") && cursor < source.length) cursor++; };
  const string = () => {
    const quote = source[cursor++];
    let value = "";
    while (cursor < source.length) {
      const char = source[cursor++];
      if (char === quote) return value;
      if (char === "\n" || char === "\r") fail("literal newline in data string");
      if (char !== "\\") { value += char; continue; }
      const escape = source[cursor++];
      const simple = { "'": "'", '"': '"', "\\": "\\", "/": "/", n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
      if (Object.hasOwn(simple, escape)) { value += simple[escape]; continue; }
      if (escape === "u" || escape === "x") {
        const length = escape === "u" ? 4 : 2;
        const hex = source.slice(cursor, cursor + length);
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) fail("invalid string escape");
        value += String.fromCharCode(Number.parseInt(hex, 16)); cursor += length; continue;
      }
      fail("unsupported string escape");
    }
    fail("unterminated data string");
  };
  const object = (depth = 0) => {
    if (depth > 4 || source[cursor++] !== "{") fail("expected shallow data object");
    const value = Object.create(null);
    whitespace();
    while (source[cursor] !== "}") {
      let key;
      if (source[cursor] === '"' || source[cursor] === "'") key = string();
      else { const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(cursor)); if (!match) fail("invalid data key"); key = match[0]; cursor += key.length; }
      if (["__proto__", "constructor", "prototype"].includes(key) || Object.hasOwn(value, key)) fail(`duplicate or reserved data key ${key}`);
      whitespace();
      if (source[cursor++] !== ":") fail("expected data colon");
      whitespace();
      if (source[cursor] === "{") value[key] = object(depth + 1);
      else if (source[cursor] === '"' || source[cursor] === "'") value[key] = string();
      else fail("only objects and literal strings are accepted");
      whitespace();
      if (source[cursor] === "}") break;
      if (source[cursor++] !== ",") fail("expected data comma");
      whitespace();
    }
    cursor++; return value;
  };
  whitespace();
  const value = object();
  whitespace();
  if (source[cursor] !== ";") fail("data object must end with a semicolon");
  return { value, start, end: cursor + 1 };
}

export function decodeHtml(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, name) => {
    if (name[0] === "#") {
      const point = name[1].toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (!point || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) fail("invalid character reference");
      return String.fromCodePoint(point);
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" }[name.toLowerCase()];
  });
}
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function scanHtml(source) {
  const elements = [], texts = [], stack = [];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  let cursor = 0;
  while (cursor < source.length) {
    const parent = stack.at(-1) || null;
    if (source.startsWith("<!--", cursor)) {
      const end = source.indexOf("-->", cursor + 4); if (end < 0) fail("unterminated comment"); cursor = end + 3; continue;
    }
    if (/^<!doctype\s+html\s*>/i.test(source.slice(cursor))) { cursor += /^<!doctype\s+html\s*>/i.exec(source.slice(cursor))[0].length; continue; }
    if (source[cursor] !== "<") {
      let end = source.indexOf("<", cursor); if (end < 0) end = source.length;
      texts.push({ start: cursor, end, value: source.slice(cursor, end), parent }); cursor = end; continue;
    }
    const closing = /^<\/([a-z][\w:-]*)\s*>/i.exec(source.slice(cursor));
    if (closing) {
      const node = stack.pop(); if (!node || node.tag !== closing[1].toLowerCase()) fail(`unbalanced closing tag ${closing[1]}`);
      node.contentEnd = cursor; node.end = cursor + closing[0].length; cursor = node.end; continue;
    }
    const opening = /^<([a-z][\w:-]*)/i.exec(source.slice(cursor));
    if (!opening) fail(`unsupported markup at ${cursor}`);
    const node = { tag: opening[1].toLowerCase(), start: cursor, parent, attributes: Object.create(null) };
    cursor += opening[0].length;
    let selfClosing = false;
    while (cursor < source.length) {
      const space = /^\s*/.exec(source.slice(cursor))[0]; cursor += space.length;
      if (source.startsWith("/>", cursor)) { selfClosing = true; cursor += 2; break; }
      if (source[cursor] === ">") { cursor++; break; }
      const match = /^[a-z_:][\w:.-]*/i.exec(source.slice(cursor)); if (!match) fail("invalid attribute");
      const key = match[0].toLowerCase(); if (Object.hasOwn(node.attributes, key)) fail(`duplicate attribute ${key}`);
      cursor += match[0].length; cursor += /^\s*/.exec(source.slice(cursor))[0].length;
      let value = null;
      if (source[cursor] === "=") {
        cursor++; cursor += /^\s*/.exec(source.slice(cursor))[0].length;
        const quote = source[cursor++]; if (quote !== '"' && quote !== "'") fail("attributes must be quoted");
        const end = source.indexOf(quote, cursor); if (end < 0) fail("unterminated attribute");
        value = decodeHtml(source.slice(cursor, end)); cursor = end + 1;
      }
      node.attributes[key] = value;
    }
    if (source[cursor - 1] !== ">") fail("unterminated opening tag");
    node.openEnd = cursor;
    elements.push(node);
    // HTML ignores the self-closing slash on ordinary non-void elements.
    // Accept it only for void elements and the source's SVG namespace.
    let svgAncestor = parent;
    while (svgAncestor && svgAncestor.tag !== "svg") svgAncestor = svgAncestor.parent;
    if (selfClosing && !voidTags.has(node.tag) && node.tag !== "svg" && !svgAncestor) fail("non-void HTML self-closing syntax");
    if (selfClosing || voidTags.has(node.tag)) { node.contentEnd = cursor; node.end = cursor; continue; }
    if (node.tag === "script" || node.tag === "style") {
      const endTag = new RegExp(`<\\/${node.tag}\\s*>`, "ig"); endTag.lastIndex = cursor;
      const end = endTag.exec(source); if (!end) fail(`unterminated ${node.tag}`);
      node.contentEnd = end.index; node.end = endTag.lastIndex; cursor = node.end; continue;
    }
    stack.push(node); if (stack.length > 128) fail("excessive nesting");
  }
  if (stack.length) fail("unclosed element");
  return { elements, texts };
}

export function applyHtmlEdits(source, edits) {
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let last = 0, output = "";
  for (const edit of ordered) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < last || edit.end < edit.start || edit.end > source.length) fail("overlapping or invalid edit");
    output += source.slice(last, edit.start) + edit.value; last = edit.end;
  }
  return output + source.slice(last);
}

export function richTextSignature(value) {
  const { elements, texts } = scanHtml(value);
  for (const node of elements) {
    const allowed = node.tag === "strong" && Object.keys(node.attributes).length === 0
      || node.tag === "span" && JSON.stringify(node.attributes) === '{"class":"accent"}';
    if (!allowed) fail("rich text permits only strong and span.accent");
  }
  // Comments, doctypes and raw elements are not accepted in translation fragments.
  if (value.includes("<!") || value.includes("<?")) fail("non-text markup in translation");
  if (!texts.some((text) => decodeHtml(text.value).trim())) fail("empty rich text");
  return elements.map((node) => ({ tag: node.tag, attributes: node.attributes, parent: node.parent ? elements.indexOf(node.parent) : null }));
}

export function renderRichText(value) {
  richTextSignature(value);
  // Decode only the documented entities, then escape every text node. Unknown
  // named entities cannot smuggle browser-only bidi controls into a rich slot.
  const { texts } = scanHtml(value);
  return applyHtmlEdits(value, texts.map((text) => ({ start: text.start, end: text.end, value: escapeHtml(decodeHtml(text.value)) })));
}
