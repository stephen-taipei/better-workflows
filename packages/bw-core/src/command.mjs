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
        tokens.push(ch);
      } else if (ch === "&" && line[i + 1] === ">") {
        tokens.push(line[i + 2] === ">" ? ">>" : ">"); // &> and &>> redirect; the target follows
        i += line[i + 2] === ">" ? 2 : 1;
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

// Two separators with nothing between them, as `) ||` leaves: keep the one
// that says less about the exit code. A parenthesis (null) is transparent:
// a group exits with its last command's code.
function weaker(a, b) {
  if (a === null) return b;
  if (a === "||" || b === "||") return "||";
  return a === "&&" ? b : a;
}

// Whether the line's exit code is the exit code of commands[index]. Only a
// chain of `&&` after it keeps that true (or `|` once pipefail is set); a
// `;`, `||`, `|` or `&` after it, or a `||` before it, lets the line exit 0
// while the command failed or never ran.
function exitAttributable(separators, index, pipefail) {
  if (separators.slice(0, index).includes("||")) return false;
  return separators.slice(index).every((sep) => sep === null || sep === "&&" || (sep === "|" && pipefail));
}

export function splitCommand(line) {
  const { tokens, opaque: substitution } = tokenize(String(line));
  const commands = [];
  const separators = []; // separators[i] follows commands[i]
  let current = [];
  let target = false; // the next token is a redirection target, not an argument
  for (const token of tokens) {
    if (target && !SEPARATORS.has(token) && token !== "(" && token !== ")") {
      target = false;
      continue;
    }
    target = false;
    if (token === "(" || token === ")") {
      if (current.length) {
        commands.push(current);
        separators.push(null);
      }
      current = [];
    } else if (SEPARATORS.has(token)) {
      if (current.length) {
        commands.push(current);
        separators.push(token);
      } else if (separators.length && token !== "\n") {
        separators[separators.length - 1] = weaker(separators.at(-1), token);
      }
      current = [];
    } else if (/^\d*[<>]/.test(token)) {
      target = /^\d*(>>?|<<?|>\||[<>]&)$/.test(token); // `> out.log`, not `>out.log` or `2>&1`
    } else {
      current.push(token);
    }
  }
  if (current.length) commands.push(current);
  else if (separators.at(-1) !== "&") separators.pop(); // a trailing `;`, `)` or newline changes nothing
  let opaque = substitution;
  let changesDirectory = false;
  let pipefail = false;
  const argvs = [];
  const attributable = [];
  for (const [i, raw] of commands.entries()) {
    const argv = stripPrefix(raw);
    if (!argv.length) continue;
    const program = argv[0].split("/").at(-1);
    if (program === "eval" || program === "xargs" || program === "source" || program === ".") opaque = true;
    if (NESTED_SHELLS.has(program) && argv.includes("-c")) opaque = true;
    if (program === "cd" || program === "pushd" || program === "popd") changesDirectory = true;
    if (program === "set" && argv.includes("pipefail")) pipefail = true;
    argvs.push([program, ...argv.slice(1)]);
    attributable.push(exitAttributable(separators, i, pipefail));
  }
  return { commands: argvs, attributable, opaque, changesDirectory };
}
