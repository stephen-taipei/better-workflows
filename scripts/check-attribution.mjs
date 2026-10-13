#!/usr/bin/env node
// Check that no commit credits an AI assistant as an author or co-author.
//
// GitHub lists everyone who authored or co-authored a commit on the default
// branch as a contributor of the repository. A commit made by a Claude Code
// cloud session is authored by `Claude <noreply@anthropic.com>` and carries
// `Co-Authored-By` and `Claude-Session` trailers, so merging one adds `claude`
// to that list. This check fails on such a commit before it is merged. It is
// the same rule as stephen-taipei/deckhand's scripts/check-attribution.py.
//
// A commit is refused when:
//   - its author or committer email is an `@anthropic.com` address;
//   - its message has a `Co-Authored-By` trailer naming Claude or an
//     `@anthropic.com` address (a human co-author is fine);
//   - its message has a `Claude-Session` trailer or a "Generated with Claude
//     Code" line.
//
// Usage: node scripts/check-attribution.mjs [REVISION_RANGE]. Without a range,
// every commit reachable from HEAD is checked. CI passes the pull request's
// `base..head`, so commits already on main are not re-checked. A problem is
// printed as `sha: message`, one line each. Exit status: 0 clean, 1 a commit
// is refused, 2 git failed.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ANTHROPIC = /@anthropic\.com\s{0,4}>?\s{0,4}$/i;
const CO_AUTHOR = /^co-authored-by:[ \t]{0,8}(.{0,400})$/i;
const SESSION = /^claude-session:/i;
const GENERATED = /generated with \[?claude code\]?/i;
const CLAUDE_NAME = /(?:^|\s)claude(?:\s|$)/i;

// Fields of one commit, NUL between fields and a record separator between commits.
const FORMAT = "%H%x00%ae%x00%ce%x00%B%x1e";

export function problemsIn(sha, authorEmail, committerEmail, message) {
  const found = [];
  const short = sha.slice(0, 7);
  if (ANTHROPIC.test(authorEmail)) found.push(`${short}: author is ${authorEmail}`);
  if (ANTHROPIC.test(committerEmail)) found.push(`${short}: committer is ${committerEmail}`);
  for (const raw of message.split(/\r?\n/)) {
    const line = raw.trim();
    const co = CO_AUTHOR.exec(line);
    if (co && (ANTHROPIC.test(co[1]) || CLAUDE_NAME.test(co[1].split("<")[0]))) {
      found.push(`${short}: co-author trailer \`${line}\``);
    } else if (SESSION.test(line)) {
      found.push(`${short}: session trailer \`${line.slice(0, 120)}\``);
    } else if (GENERATED.test(line)) {
      found.push(`${short}: generated-with line \`${line.slice(0, 120)}\``);
    }
  }
  return found;
}

export function check(root, revision = "HEAD") {
  const out = execFileSync("git", ["log", `--format=${FORMAT}`, revision], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const found = [];
  for (const record of out.split("\x1e")) {
    const trimmed = record.replace(/^\n+|\n+$/g, "");
    if (!trimmed) continue;
    const [sha, author, committer, ...rest] = trimmed.split("\x00");
    found.push(...problemsIn(sha, author, committer, rest.join("\x00")));
  }
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const revision = process.argv[2] || "HEAD";
  const root = process.env.CHECK_ATTRIBUTION_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  let found;
  try {
    found = check(root, revision);
  } catch (error) {
    console.error(`check-attribution: git log ${revision} failed: ${error.stderr || error.message}`);
    process.exit(2);
  }
  for (const line of found) console.log(line);
  if (found.length) {
    console.error(`check-attribution: ${found.length} problem(s). Re-author the commit and drop the trailer before merging.`);
    process.exit(1);
  }
}
