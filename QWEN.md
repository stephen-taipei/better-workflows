# Better Workflows bridge for Qwen Code

Use the host-neutral control plane from the installed extension, never from a
path relative to the user's current repository. Bind `<extension-root>` to the
directory from which Qwen Code loaded this `QWEN.md`; that same directory must
contain `qwen-extension.json` with name `better-workflows`. If Qwen Code does
not expose the context source path, the supported user-install fallback is
`$HOME/.qwen/extensions/better-workflows`. Verify the manifest, version, and
helper before use. Do not guess from the current working directory or perform a
broad filesystem search; if exactly one active root cannot be proven, stop.

Run `node "<extension-root>/plugins/better-workflows/scripts/sbw.mjs" host doctor qwen-code`,
then use `route preview` or the matching skill under
`<extension-root>/plugins/better-workflows/skills/`. The literal
`${extensionPath}` is not assumed to expand inside this context file.

Shared state defaults to `XDG_STATE_HOME/better-workflows` when available and
otherwise `~/.better-workflows`; set `SBW_STATE_ROOT` for an explicit location.

Before a repository mutation, run `workspace preflight`; create or reuse only
the current task's `TaskWorkspaceLeaseV1` worktree. Direct is allowed only when
`AutoRiskAssessmentV1` selects `direct-fast-path`. Protected or remote targets,
release, deploy, credentials, migrations, and unknown outcomes require the
governed evidence route. Replay re-evaluates evidence and must never repeat a
merge, push, deploy, release, or other side effect.

Qwen Code uses the core bridge. Do not claim Codex-native picker, subagent,
host-trust, or plugin-cache publication capabilities.
