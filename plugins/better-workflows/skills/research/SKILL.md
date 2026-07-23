---
name: research
description: Goal-first 多觀點研究、反證、方案比較與架構決策。選擇 $better-workflows:research 時使用。
---

# Research deliberation

Read `../better-workflows/SKILL.md` completely and follow it, including the Goal-first entry contract.

Use template `research-deliberation` and select the mode dynamically. Read
`../better-workflows/references/deliberation-roster.md` completely before
selecting participants.

Run one bounded, role-based deliberation rather than an unbounded discussion:

1. Create or continue the persistent Goal, then start a `deep` run unless the
   risk assessment requires `critical`.
2. Build a sanitized decision dossier. Probe the configured roster first; only
   models that pass the semantic CLI probe in this invocation may participate.
   Gemini is routed through Agy in this runtime. Apply `medium` reasoning to
   bounded `direct`/`verified` work and `high` reasoning to `auto`/`deep`/
   `critical` work unless current evidence justifies an explicit override.
3. Give every active model one bounded role and the same dossier. Independent
   roles may overlap across brands, but no participant may edit files, invoke
   side effects, accept risk, or decide by vote.
4. Reconcile their independent evidence and counterarguments. Use the
   capability-ranked final arbiter to produce a JSON decision and executable
   plan with owner, dependencies, validation, and rollback for each step.
5. The Root verifies the evidence, records it against the run, and is the only
   authority that may approve implementation or declare completion.

External CLI probes and deliberation require explicit user authorization plus
sanitized, non-confidential material. An unavailable provider is evidence of
unavailability, not a prompt to log in interactively or lower the safety bar.
Do not decide by majority vote.
