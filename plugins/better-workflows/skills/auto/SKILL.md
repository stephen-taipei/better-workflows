---
name: auto
description: Goal-first 自動入口（推薦）；自動選 template、mode 與 critics。選擇 $better-workflows:auto 時使用。
---

# Auto

Read `../better-workflows/SKILL.md` completely and follow it, including the Goal-first entry contract.

Before substantial work, run `sbw doctor --capabilities` and
`sbw route preview --goal "<goal>" --scope <path>`. Report the route source,
primary entry/template, effective mode, optional support exclusions, and
blockers. If the preview returns built-in `auto` with no concrete template,
select exactly one template from current evidence and preview it explicitly;
never fabricate an `auto` template.

Select the final template and mode from the preview, current risk, and evidence.
Profiles may raise the minimum mode but may not replace an explicit selector or
grant authority. Keep model aliases internal unless the user asks for them.
