// Splits a shell command line into simple commands and their argv, without
// executing anything. Anything the splitter cannot see through (command
// substitution, eval, nested shells) marks the line as opaque.

const SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n"]);
const NESTED_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const WRAPPERS = new Set(["sudo", "command", "env", "nohup", "time", "exec", "nice", "timeout"]);

function tokenize(line) {
  const tokens = [];
  let current = "";
  let has = false;
  let opaque = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return { tokens, opaque: true };
      current += line.slice(i + 1, end);
      has = true;
      i = end;
    } else if (ch === "\"") {
      let j = i + 1;
      for (; j < line.length && line[j] !== "\""; j += 1) {
        if (line[j] === "\\" && j + 1 < line.length) {
          current += line[j + 1];
          j += 1;
        } else {
          if (line[j] === "$" || line[j] === "`") opaque = true;
          current += line[j];
        }
      }
      if (j >= line.length) return { tokens, opaque: true };
      has = true;
      i = j;
    } else if (ch === "\\" && i + 1 < line.length) {
      if (line[i + 1] !== "\n") current += line[i + 1];
      has = true;
      i += 1;
    } else if (ch === "`" || (ch === "$" && (line[i + 1] === "(" || line[i + 1] === "{"))) {
      opaque = true;
      current += ch;
      has = true;
    } else if (ch === " " || ch === "\t") {
      if (has) tokens.push(current);
      current = "";
      has = false;
    } else if (ch === "&" && current.endsWith(">")) {
      current += ch; // >&2 style redirection
    } else if (ch === "\n" || ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
      if (has) tokens.push(current);
      current = "";
      has = false;
      const pair = line.slice(i, i + 2);
      if (pair === "&&" || pair === "||") {
        tokens.push(pair);
        i += 1;
      } else if (ch === "(" || ch === ")") {
        tokens.push(";");
      } else if (ch === "&" && line[i + 1] === ">") {
        i += 1; // &> redirection: drop operator, keep scanning
      } else {
        tokens.push(ch);
      }
    } else {
      current += ch;
      has = true;
    }
  }
  if (has) tokens.push(current);
  return { tokens, opaque };
}

function stripPrefix(argv) {
  let rest = argv;
  for (;;) {
    while (rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest = rest.slice(1);
    if (!rest.length || !WRAPPERS.has(rest[0])) return rest;
    rest = rest.slice(1);
    while (rest.length && (rest[0].startsWith("-") || /^\d+[smhd]?$/.test(rest[0]))) rest = rest.slice(1);
  }
}

export function splitCommand(line) {
  const { tokens, opaque: substitution } = tokenize(String(line));
  const commands = [];
  let current = [];
  for (const token of tokens) {
    if (SEPARATORS.has(token)) {
      if (current.length) commands.push(current);
      current = [];
    } else if (!/^\d*[<>]/.test(token)) {
      current.push(token);
    }
  }
  if (current.length) commands.push(current);
  let opaque = substitution;
  let changesDirectory = false;
  const argvs = [];
  for (const raw of commands) {
    const argv = stripPrefix(raw);
    if (!argv.length) continue;
    const program = argv[0].split("/").at(-1);
    if (program === "eval" || program === "xargs" || program === "source" || program === ".") opaque = true;
    if (NESTED_SHELLS.has(program) && argv.includes("-c")) opaque = true;
    if (program === "cd" || program === "pushd" || program === "popd") changesDirectory = true;
    argvs.push([program, ...argv.slice(1)]);
  }
  return { commands: argvs, opaque, changesDirectory };
}
