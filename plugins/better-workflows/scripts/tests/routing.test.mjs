import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  capabilitySnapshot,
  claimRouteReceipt,
  installPersonalRoutingProfile,
  previewRoute,
  recordRouteReceipt,
  validateRouteReceipt,
  validateRoutingProfile
} from "../lib/routing.mjs";

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "sbw-routing-workspace-"));
}

async function writeProfile(root, profile) {
  await mkdir(path.join(root, ".codex"), { recursive: true });
  await writeFile(
    path.join(root, ".codex", "better-workflows.json"),
    `${JSON.stringify(profile, null, 2)}\n`
  );
}

function profile(rules) {
  return { schemaVersion: 1, rules };
}

function rule(id, {
  priority = 0,
  match = {},
  entry,
  template,
  minimumMode,
  supportSkills = [],
  requiredCapabilities = []
}) {
  return {
    id,
    priority,
    match,
    route: {
      ...(entry ? { entry } : { template }),
      ...(minimumMode ? { minimumMode } : {}),
      supportSkills,
      requiredCapabilities
    }
  };
}

test("route precedence is explicit, workspace, personal, then built-in auto", async () => {
  const cwd = await workspace();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-routing-state-"));
  await writeProfile(
    cwd,
    profile([
      rule("workspace-pr", {
        priority: 10,
        match: { keywords: ["merge"] },
        entry: "pr-to-dev",
        minimumMode: "critical"
      })
    ])
  );
  await mkdir(path.join(stateRoot, "routing"));
  await writeFile(
    path.join(stateRoot, "routing", "profile.json"),
    `${JSON.stringify(
      profile([
        rule("personal-research", {
          match: { keywords: ["merge"] },
          entry: "research",
          minimumMode: "deep"
        })
      ])
    )}\n`
  );

  const workspaceRoute = await previewRoute({
    cwd,
    stateRoot,
    goal: "merge this change",
    scope: ["src"]
  });
  assert.equal(workspaceRoute.source, "workspace-profile");
  assert.equal(workspaceRoute.primary.entry, "pr-to-dev");
  assert.equal(workspaceRoute.effectiveMode, "critical");
  assert.deepEqual(workspaceRoute.ignoredOverrides, ["personal-profile:personal-research"]);

  const explicit = await previewRoute({
    cwd,
    stateRoot,
    goal: "merge this change",
    scope: ["src"],
    entry: "research",
    mode: "direct"
  });
  assert.equal(explicit.source, "explicit-entry");
  assert.equal(explicit.primary.entry, "research");
  assert.equal(explicit.effectiveMode, "deep");

  const personalFallback = await previewRoute({
    cwd,
    stateRoot,
    goal: "research architecture",
    scope: ["src"]
  });
  assert.equal(personalFallback.source, "built-in-auto");
  assert.equal(personalFallback.primary.template, null);
  assert.equal(personalFallback.needsSelection, true);
});

test("workspace non-match falls back to personal and matching uses category AND with value OR", async () => {
  const cwd = await workspace();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-routing-personal-"));
  await writeProfile(
    cwd,
    profile([
      rule("workspace-other", {
        match: { keywords: ["release"] },
        entry: "ci-release"
      })
    ])
  );
  await mkdir(path.join(stateRoot, "routing"));
  await writeFile(
    path.join(stateRoot, "routing", "profile.json"),
    `${JSON.stringify(
      profile([
        rule("first-equal-priority", {
          priority: 20,
          match: {
            keywords: ["refactor", "architecture"],
            domains: ["monorepo"],
            tags: ["maintenance", "cleanup"]
          },
          entry: "monorepo-refactor",
          minimumMode: "deep"
        }),
        rule("second-equal-priority", {
          priority: 20,
          match: {
            keywords: ["architecture"],
            domains: ["monorepo"],
            tags: ["cleanup"]
          },
          entry: "research"
        })
      ])
    )}\n`
  );
  const route = await previewRoute({
    cwd,
    stateRoot,
    goal: "architecture cleanup",
    scope: ["packages/core"],
    domains: ["monorepo"],
    tags: ["cleanup"]
  });
  assert.equal(route.source, "personal-profile");
  assert.equal(route.profileRule, "first-equal-priority");
  assert.equal(route.primary.entry, "monorepo-refactor");
});

test("missing optional support is excluded while a missing required capability blocks", async () => {
  const cwd = await workspace();
  const stateRoot = path.join(cwd, "missing-state");
  await writeProfile(
    cwd,
    profile([
      rule("capabilities", {
        match: {},
        entry: "review-issues",
        supportSkills: ["definitely-not-installed"],
        requiredCapabilities: ["mcp:host-tools"]
      })
    ])
  );
  const route = await previewRoute({ cwd, stateRoot, goal: "review", scope: ["."] });
  assert.equal(route.ok, false);
  assert.deepEqual(route.advisorySupportSkills, []);
  assert.equal(route.excludedSupportSkills[0].skill, "definitely-not-installed");
  assert.ok(route.blockers.includes("mcp:host-tools:unsupported"));
});

test("capability snapshot is cache-only and leaves a missing state root untouched", async () => {
  const cwd = await workspace();
  const stateRoot = path.join(cwd, "never-created");
  const snapshot = await capabilitySnapshot({
    cwd,
    stateRoot,
    requiredCapabilities: ["provider:agy", "command:node"]
  });
  assert.ok(snapshot.blockers.includes("provider:agy:requires-authority"));
  assert.equal(
    snapshot.capabilities.find((item) => item.id === "command:node").status,
    "available"
  );
  await assert.rejects(access(stateRoot));
});

test("capability snapshot resolves and fingerprints a callable symlink command without invoking it", async () => {
  const cwd = await workspace();
  const bin = path.join(cwd, "bin");
  await mkdir(bin);
  const target = path.join(bin, "real-tool");
  const marker = path.join(cwd, "must-not-exist");
  await writeFile(
    target,
    `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\n`,
    { mode: 0o755 }
  );
  await symlink(target, path.join(bin, "linked-tool"));
  const snapshot = await capabilitySnapshot({
    cwd,
    stateRoot: path.join(cwd, "state"),
    env: { ...process.env, PATH: bin },
    requiredCapabilities: ["command:linked-tool"]
  });
  const capability = snapshot.capabilities[0];
  assert.equal(capability.status, "available");
  assert.equal(capability.fingerprint.resolvedPath, await realpath(target));
  assert.equal(typeof capability.fingerprint.digest, "string");
  await assert.rejects(access(marker));
});

test("capability and receipt digests change when an installed support skill changes in place", async () => {
  const cwd = await workspace();
  const stateRoot = path.join(cwd, "state");
  const skillDirectory = path.join(cwd, ".codex", "skills", "local-advisor");
  await mkdir(skillDirectory, { recursive: true });
  const skillPath = path.join(skillDirectory, "SKILL.md");
  await writeFile(skillPath, "# Local advisor\nversion one\n");
  await writeProfile(
    cwd,
    profile([
      rule("local-support", {
        match: {},
        entry: "review-issues",
        supportSkills: ["local-advisor"]
      })
    ])
  );
  const preview = await previewRoute({ cwd, stateRoot, goal: "review", scope: ["."] });
  const receipt = await recordRouteReceipt({ stateRoot, cwd, preview });
  await writeFile(skillPath, "# Local advisor\nversion two\n");
  const changed = await previewRoute({ cwd, stateRoot, goal: "review", scope: ["."] });
  assert.notEqual(changed.bindings.capabilityDigest, preview.bindings.capabilityDigest);
  await assert.rejects(
    validateRouteReceipt({ stateRoot, cwd, receiptId: receipt.receiptId }),
    /capabilityDigest/
  );
});

test("profile schema rejects unknown keys, excess support, and unsafe workspace symlinks", async () => {
  assert.throws(
    () =>
      validateRoutingProfile({
        schemaVersion: 1,
        unknown: true,
        rules: [rule("valid", { match: {}, entry: "auto" })]
      }),
    /unknown keys/
  );
  assert.throws(
    () =>
      validateRoutingProfile(
        profile([
          rule("too-many", {
            match: {},
            entry: "auto",
            supportSkills: ["one", "two", "three", "four"]
          })
        ])
      ),
    /exceeds 3 items/
  );
  const cwd = await workspace();
  const outside = await workspace();
  await writeFile(
    path.join(outside, "profile.json"),
    `${JSON.stringify(profile([rule("outside", { match: {}, entry: "auto" })]))}\n`
  );
  await symlink(outside, path.join(cwd, ".codex"));
  await assert.rejects(
    previewRoute({
      cwd,
      stateRoot: path.join(cwd, "state"),
      goal: "anything",
      scope: ["."]
    }),
    /symlink/
  );
});

test("personal Profile installation is relative, atomic, private, and immediately readable", async () => {
  const cwd = await workspace();
  const stateRoot = path.join(cwd, "state");
  const profileFile = "personal-profile.json";
  await writeFile(
    path.join(cwd, profileFile),
    `${JSON.stringify(
      profile([
        rule("personal-review", {
          match: { keywords: ["review"] },
          entry: "review-issues",
          minimumMode: "verified"
        })
      ])
    )}\n`
  );
  const installed = await installPersonalRoutingProfile({
    cwd,
    stateRoot,
    file: profileFile
  });
  assert.equal((await stat(installed.target)).mode & 0o777, 0o600);
  const route = await previewRoute({ cwd, stateRoot, goal: "review src", scope: ["src"] });
  assert.equal(route.source, "personal-profile");
  await assert.rejects(
    installPersonalRoutingProfile({ cwd, stateRoot, file: path.join(cwd, profileFile) }),
    /relative path/
  );
});

test("route receipts bind profiles and capabilities, expire safely, and are single-use", async () => {
  const cwd = await workspace();
  const stateRoot = path.join(cwd, "state");
  await writeProfile(
    cwd,
    profile([
      rule("review", {
        match: { keywords: ["review"] },
        entry: "review-issues",
        minimumMode: "verified"
      })
    ])
  );
  const preview = await previewRoute({ cwd, stateRoot, goal: "review src", scope: ["src"] });
  const recorded = await recordRouteReceipt({ stateRoot, cwd, preview });
  const valid = await validateRouteReceipt({
    stateRoot,
    cwd,
    receiptId: recorded.receiptId
  });
  assert.equal(valid.preview.routeDigest, preview.routeDigest);
  await claimRouteReceipt({ stateRoot, receiptId: recorded.receiptId });
  await assert.rejects(
    validateRouteReceipt({ stateRoot, cwd, receiptId: recorded.receiptId }),
    /already claimed/
  );

  const secondPreview = await previewRoute({
    cwd,
    stateRoot,
    goal: "review again",
    scope: ["src"]
  });
  const second = await recordRouteReceipt({ stateRoot, cwd, preview: secondPreview });
  const rawProfile = JSON.parse(
    await readFile(path.join(cwd, ".codex", "better-workflows.json"), "utf8")
  );
  rawProfile.rules[0].priority = 999;
  await writeProfile(cwd, rawProfile);
  await assert.rejects(
    validateRouteReceipt({ stateRoot, cwd, receiptId: second.receiptId }),
    /profileDigest/
  );

  const thirdPreview = await previewRoute({
    cwd,
    stateRoot,
    goal: "review expiry",
    scope: ["src"]
  });
  const third = await recordRouteReceipt({ stateRoot, cwd, preview: thirdPreview });
  const expired = JSON.parse(await readFile(third.path, "utf8"));
  expired.expiresAt = "2000-01-01T00:00:00.000Z";
  await writeFile(third.path, `${JSON.stringify(expired, null, 2)}\n`);
  await assert.rejects(
    validateRouteReceipt({ stateRoot, cwd, receiptId: third.receiptId }),
    /expired/
  );
});
