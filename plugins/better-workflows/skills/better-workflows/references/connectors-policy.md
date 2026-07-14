# Connectors policy gates

Always defer to the current repository `AGENTS.md`; these are mandatory routing reminders:

- Never run local iOS builds, `xcodebuild`, `swift build`, `pod install`, or SPM resolution unless the user explicitly authorizes it in the current task.
- Add every new Swift file to `project.pbxproj`; serialize all pbxproj edits through the root.
- Serialize Prisma schema and migrations. Never run `prisma db push`.
- Verify backend response fields against iOS and Android models for cross-platform changes.
- Preserve `/api/v1/*` and legacy neutral routes unless a breaking-version plan explicitly says otherwise.
- Ensure Connectors iOS requests use the centralized client-contract headers.
- Update and validate all 41 locales when localization is in scope.
- Serialize Web/Admin deploy workflows and never queue another while one is queued or running.
- Preserve `dev -> staging -> main` and use non-fast-forward release merges.
- Prefer Nx through `pnpm nx`; check help or docs instead of guessing flags.
- Use webwright first for browser interaction.
- Root owns worktrees, integration, GitHub mutations, merge, deploy, and exact cleanup.
