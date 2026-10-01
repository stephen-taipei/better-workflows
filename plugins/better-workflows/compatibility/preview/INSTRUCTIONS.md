# Better Workflows Preview host bridge

This directory is the published compatibility pack for Preview hosts. It is a
manual bridge to the same host-neutral `scripts/sbw.mjs` control layer; it is
not a native extension, an authenticated Tier 1 conformance receipt, or a claim
that the host exposes Codex-equivalent UX.

Before repository work, the host should read its matching JSON manifest and
these instructions, then invoke the plugin-local helper with Node.js 22.14 or
newer:

Shared state defaults to `XDG_STATE_HOME/better-workflows` when available and
otherwise `~/.better-workflows`; set `SBW_STATE_ROOT` to bind another exact
location.

```bash
node <better-workflows-plugin-root>/scripts/sbw.mjs host doctor <host-id>
node <better-workflows-plugin-root>/scripts/sbw.mjs workspace preflight --intent read-only
```

For possible Git mutation, follow the returned preflight and the Auto route:

1. Stop on a dirty source, detached or missing target, or ownership conflict.
2. Create or register a task-owned worktree before editing.
3. Use Auto's fast path only when `AutoRiskAssessmentV1` explicitly returns
   `direct-fast-path`; otherwise follow Auto's governed evidence route.
4. Never treat this pack as push, PR merge, deploy, release, or cleanup
   authority.
5. Report the host as Preview and disclose that native picker, subagent, host
   trust, and plugin-cache behavior may be unavailable or unverified.

`sbw host doctor` is only a local compatibility smoke check for these hosts.
When the host has no executable extension probe, its conformance result is
`UNPROVEN`, never `PASS`; it cannot upgrade a Preview combination to Tier 1.
Preview remains read-only/manual until semantic session identity, controlled
invocation, evidence replay, and provider-bound conformance receipts exist.
v4.0.0 release eligibility requires the separate eight-combination Tier 1
package/core bridge gate, with authenticated CI provenance. That gate is not
proof of authenticated host/model sessions or equivalent native sandbox,
cancellation, and evidence-mapping behavior.
