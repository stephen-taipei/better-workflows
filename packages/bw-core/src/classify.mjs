import { splitCommand } from "./command.mjs";

// Git options that take a value and may appear before the subcommand.
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function gitSubcommand(argv) {
  let i = 1;
  while (i < argv.length && argv[i].startsWith("-")) {
    i += GIT_VALUE_OPTIONS.has(argv[i]) ? 2 : 1;
  }
  return argv.slice(i);
}

function optionValue(args, names) {
  for (let i = 0; i < args.length; i += 1) {
    for (const name of names) {
      if (args[i] === name) return args[i + 1];
      if (name.startsWith("--") && args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
      if (!name.startsWith("--") && args[i].startsWith(name) && args[i].length > name.length) return args[i].slice(name.length);
    }
  }
  return undefined;
}

function positional(args) {
  return args.filter((arg) => !arg.startsWith("-"));
}

// Built-in side-effect kinds. Each returns a target description or null.
const BUILTIN_ACTIONS = [
  {
    kind: "git-push",
    match(argv) {
      if (argv[0] !== "git") return null;
      const sub = gitSubcommand(argv);
      if (sub[0] !== "push") return null;
      const [remote, ...refspecs] = positional(sub.slice(1));
      return { remote: remote ?? null, refspecs, delete: sub.includes("--delete") || sub.includes("-d"), force: sub.some((a) => a === "-f" || a.startsWith("--force")) };
    },
  },
  {
    kind: "gh-pr-merge",
    match: (argv) => (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "merge" ? { pr: positional(argv.slice(3))[0] ?? null } : null),
  },
  {
    kind: "gh-pr-create",
    match: (argv) => (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "create" ? { head: optionValue(argv.slice(3), ["--head", "-H"]) ?? null } : null),
  },
  {
    kind: "gh-release",
    match: (argv) => (argv[0] === "gh" && argv[1] === "release" && ["create", "delete", "edit", "upload"].includes(argv[2])
      ? { operation: argv[2], tag: positional(argv.slice(3))[0] ?? null } : null),
  },
  {
    kind: "gh-api-write",
    match(argv) {
      if (argv[0] !== "gh" || argv[1] !== "api") return null;
      const args = argv.slice(2);
      const method = (optionValue(args, ["--method", "-X"]) ?? "").toUpperCase();
      const hasFields = args.some((a) => /^(-f|-F|--field|--raw-field|--input)/.test(a));
      if (!WRITE_METHODS.has(method) && !(method === "" && hasFields)) return null;
      return { method: method || "POST", endpoint: positional(args)[0] ?? null };
    },
  },
  {
    kind: "package-publish",
    match: (argv) => (["npm", "pnpm", "yarn", "bun"].includes(argv[0]) && argv.slice(1).includes("publish") ? { tool: argv[0] } : null),
  },
  {
    kind: "http-write",
    match(argv) {
      if (argv[0] !== "curl" && argv[0] !== "wget") return null;
      const args = argv.slice(1);
      const method = (optionValue(args, ["--request", "-X", "--method"]) ?? "").toUpperCase();
      const hasBody = args.some((a) => /^(-d|--data|--data-\w+|--json|-F|--form|-T|--upload-file|--post-data|--post-file)/.test(a));
      if (!WRITE_METHODS.has(method) && !hasBody) return null;
      return { method: method || "POST", url: positional(args).find((a) => /^https?:/.test(a)) ?? null };
    },
  },
];

// argv[0] is already reduced to its basename, so compare the rule's program
// the same way; "./deploy.sh" matches deploy.sh run from any path.
function matchesPrefix(argv, prefix) {
  return prefix.length <= argv.length
    && prefix.every((token, i) => token === "*" || (i === 0 ? token.split("/").at(-1) : token) === argv[i]);
}

// Classifies a command line into side-effect actions and evidence kinds.
export function classifyCommand(line, policy) {
  const { commands, opaque, changesDirectory } = splitCommand(line);
  const actions = [];
  const evidence = [];
  for (const argv of commands) {
    for (const rule of BUILTIN_ACTIONS) {
      const target = rule.match(argv);
      if (target) actions.push({ kind: rule.kind, argv, target });
    }
    for (const rule of policy.actions.custom) {
      if (rule.argv.some((prefix) => matchesPrefix(argv, prefix))) actions.push({ kind: rule.kind, argv, target: {} });
    }
    for (const rule of policy.evidence.kinds) {
      if (rule.argv.some((prefix) => matchesPrefix(argv, prefix))) evidence.push({ kind: rule.kind, argv });
    }
  }
  return { commands, actions, evidence, opaque, changesDirectory };
}

export const BUILTIN_ACTION_KINDS = BUILTIN_ACTIONS.map((rule) => rule.kind);
