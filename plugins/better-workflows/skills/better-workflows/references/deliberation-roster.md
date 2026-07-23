# CLI-proven deliberation roster

`research-deliberation` replaces the former AI-meeting alias. It is a mediated
deliberation: independent roles review the same sanitized case, the Root
reconciles their claims, and one capability-ranked arbiter produces the final
decision and executable plan. It is not a vote, an agent swarm, or an
unbounded loop.

## Eligibility and safety

1. Start the persistent Goal and the `research-deliberation` run before
   gathering views.
2. A model is an active participant only after its exact configured CLI/model
   pair passes the semantic roster probe. Binary discovery, a help screen, and
   a configured name are not proof. Every new research flow reads the full
   brand list; each successful `medium` or `high` roster profile is reused for
   at most 24 hours.
3. Codex uses an isolated `read-only` child. Any non-Codex CLI requires both
   explicit user authorization for external egress and a sanitized,
   non-confidential prompt. Never send source, secrets, private history, or
   regulated data through argv-based providers.
4. In this runtime, Gemini is reached through `agy`; do not invoke a standalone
   `gemini` CLI. Agy can expose Gemini-, Claude-, or GPT-OSS-branded models,
   but the evidence records Agy as the transport and the model brand separately.
5. The cache is invalidated on expiry, `--refresh`, roster configuration change,
   or CLI path/binary digest change. Each reasoning-effort profile has a
   separate cache. Targeted `--provider` probes never replace the complete
   cache. An unavailable, unauthenticated, non-interactive-unsafe,
   or marker-mismatched
   provider stays out of the roster. Do not retry it as an interactive login.

## Reasoning effort for every model

Every participant receives a `medium` or `high` reasoning-effort request. Use
`auto` by default: `direct` and `verified` resolve to `medium`; `auto`, `deep`,
and `critical` resolve to `high`. Override only when the task evidence justifies
it. Codex receives the native effort setting. Agy selects an exact effort-named
model variant when one exists, including `gemini-3.6-flash-medium` or
`gemini-3.6-flash-high`, and passes Agy's native `--effort` flag when the
selected model supports it. A model such as `claude-opus-4-6-thinking` that
rejects the flag is kept as a high-only `model-variant`; it is never falsely
reported as native effort. Other CLIs receive the requested depth as bounded
prompt guidance and report that transport honestly in their metadata.

## Commands

For a safe roster probe:

~~~bash
dw deliberation roster \
  --allow-external-providers --sanitized \
  --reasoning-effort auto --mode deep --refresh
~~~

To collect role-specific independent memos and get the final plan in one
bounded invocation, place only sanitized case material in a file:

~~~bash
dw deliberation deliberate \
  --prompt-file <sanitized-case.md> \
  --mode deep --reasoning-effort auto \
  --allow-external-providers --sanitized
~~~

Attach the command output as `deliberation-roster`,
`role-perspective-matrix`, `decision-record`, `executable-plan`, and
`arbiter-verdict` evidence. If any command returns no active arbiter, stop as
inconclusive rather than accepting a lower, unproven result.

## Role and decision rules

- Every active model receives exactly one bounded role for the current
  deliberation. The same role may deliberately appear across brands to test
  whether their reasoning converges for evidence-based reasons.
- Independent roles do not see each other's output. The arbiter receives their
  submissions as untrusted evidence and must reconcile contradictions against
  the sanitized case.
- The Root remains the only party that accepts risk or approves implementation.
  The model plan is advisory until the Root verifies the evidence and any
  required action gates.
- The final arbiter is selected only from actively proven participants in this
  strict order: `GPT-5.6 Sol`, `GPT-5.6 Terra`, `GPT-5.6 Luna`, `Claude Fable
  5`, then `Claude Opus 5`. The first model that returns a schema-valid decision
  wins; failed candidates are recorded and the next one is attempted. No
  candidate means fail closed.
