import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, writeFile, mkdir, rm, symlink, open, chmod, rename, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { digestObject, pluginRoot } from '../lib/core.mjs';
import { observeClaudeHostBindingV1, validateClaudeHostBindingV1 } from '../lib/claude-host-binding-v1.mjs';
const mac = { skip: process.platform !== 'darwin' };
async function fixture(t, script = '#!/bin/sh\nprintf "2.1.292 (Claude Code)\\n"\n') {
  const directory = await mkdtemp('/private/tmp/claude-host-binding-test-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = path.join(directory, 'bundle'), bin = path.join(directory, 'bin');
  await cp(pluginRoot(), bundle, { recursive: true });
  await mkdir(bin);
  await mkdir(path.join(bundle, '.claude-plugin'), { recursive: true });
  const pkg = JSON.parse(await readFile(path.join(bundle, 'package.json'), 'utf8'));
  pkg.version = '5.1.0';
  await writeFile(path.join(bundle, 'package.json'), JSON.stringify(pkg));
  await writeFile(path.join(bundle, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'better-workflows', version: '5.1.0' }));
  await writeFile(path.join(bin, 'claude'), script, { mode: 0o755 });
  const module = await import(pathToFileURL(path.join(bundle, 'scripts/lib/claude-host-binding-v1.mjs')));
  return { directory, bundle, bin, module, env: { PATH: bin } };
}
function rewriteDigest(value) { const { observationDigest, ...body } = value; return { ...body, observationDigest: digestObject(body) }; }
async function observation(f) { return f.module.observeClaudeHostBindingV1({ osId: 'macos', env: f.env }); }
test('unsupported platform fails closed before executing a CLI', async () => {
  const value = await observeClaudeHostBindingV1({ osId: 'windows', env: {} });
  assert.equal(value.result, 'HOLD');
  assert.deepEqual(value.blockers, ['host-binding-platform-unavailable']);
  assert.equal(value.execution.attempted, false);
  assert.equal(value.releaseEligible, false);
  validateClaudeHostBindingV1(value);
});
test('valid future bundle observes exact helper/CLI bytes without fabricating a Git revision', mac, async t => {
  const f = await fixture(t), value = await observation(f);
  assert.equal(value.result, 'PASS');
  assert.equal(value.host.reportedVersion, '2.1.292');
  assert.equal(value.execution.groupTerminated, true);
  assert.equal(value.source.installedSourceState, 'not-observed');
  assert.equal(value.provenanceVerified, false);
  assert.equal(value.releaseEligible, false);
  assert.ok(value.source.bundleFileCount > 10);
  assert.equal('revision' in value.source, false);
  f.module.validateClaudeHostBindingV1(value, { bundleDigest: value.source.bundleDigest });
});
test('a changed helper invalidates a previously pinned bundle', mac, async t => {
  const f = await fixture(t), before = await observation(f);
  await writeFile(path.join(f.bundle, 'scripts/sbw.mjs'), '\n// changed helper bytes\n', { flag: 'a' });
  const after = await observation(f);
  assert.equal(after.result, 'PASS');
  assert.notEqual(after.source.bundleDigest, before.source.bundleDigest);
  assert.throws(() => f.module.validateClaudeHostBindingV1(after, { bundleDigest: before.source.bundleDigest }), /expected bundleDigest mismatch/);
});
for (const [label, mutate, blocker] of [
  ['missing Claude descriptor', f => rm(path.join(f.bundle, '.claude-plugin/plugin.json')), 'host-binding-manifest-unavailable'],
  ['mismatched descriptor', f => writeFile(path.join(f.bundle, '.claude-plugin/plugin.json'), JSON.stringify({ name:'better-workflows',version:'4.0.0' })), 'host-binding-manifest-invalid'],
  ['missing CLI', f => rm(path.join(f.bin, 'claude')), 'host-binding-executable-unavailable'],
  ['failing version probe', f => writeFile(path.join(f.bin, 'claude'), '#!/bin/sh\necho PRIVATE_SENTINEL >&2\nexit 2\n'), 'host-binding-version-probe-failed'],
  ['unrecognized version output', f => writeFile(path.join(f.bin, 'claude'), '#!/bin/sh\necho arbitrary-version-claim\n'), 'host-binding-version-format-invalid'],
  ['symlink in bundle', f => symlink('/etc/passwd', path.join(f.bundle, 'unsafe-link')), 'host-binding-bundle-unsafe'],
  ['changed registry contract', async f => { const name=path.join(f.bundle,'config/host-support-v1.json');const r=JSON.parse(await readFile(name,'utf8'));r.recommended.hostId='claude-code';await writeFile(name,JSON.stringify(r)); }, 'host-binding-registry-drift'],
  ['oversized bundle file', async f => { const h=await open(path.join(f.bundle,'oversized'),'w');await h.truncate(8*1024*1024+1);await h.close(); }, 'host-binding-bundle-limit-exceeded']
]) test(`rejects ${label}`, mac, async t => {
  const f = await fixture(t); await mutate(f); const value = await observation(f);
  assert.equal(value.result, 'HOLD'); assert.ok(value.blockers.includes(blocker), JSON.stringify(value));
  assert.equal(JSON.stringify(value).includes('PRIVATE_SENTINEL'), false);
});
test('bundle mutation during version execution is detected', mac, async t => {
  const f = await fixture(t, '#!/bin/sh\nprintf "drift" >> config/host-support-v1.json\nprintf "2.1.292 (Claude Code)\\n"\n');
  const value = await observation(f);
  assert.equal(value.result, 'HOLD'); assert.ok(value.blockers.includes('host-binding-source-drift'));
});
test('version probe is bounded when the executable exceeds output limits', mac, async t => {
  const f = await fixture(t, '#!/bin/sh\n/usr/bin/yes overflow | /usr/bin/head -c 131072\n');
  const value = await observation(f);
  assert.equal(value.result, 'HOLD'); assert.ok(value.blockers.includes('host-binding-version-probe-failed'));
});
for (const [label, suffix] of [
  ['nonzero exit', 'printf "PRIVATE_SENTINEL\\n" >&2\nexit 23\n'],
  ['stderr overflow', '/usr/bin/yes PRIVATE_SENTINEL | /usr/bin/head -c 131072 >&2\n']
]) test(`valid version stdout cannot mask ${label}`, mac, async t => {
  const f = await fixture(t, '#!/bin/sh\nprintf "2.1.292 (Claude Code)\\n"\n' + suffix);
  const value = await observation(f);
  assert.equal(value.result, 'HOLD');
  assert.ok(value.blockers.includes('host-binding-version-probe-failed'));
  assert.equal(value.execution.attempted, true);
  assert.equal(value.host.reportedVersion, null);
  assert.equal(JSON.stringify(value).includes('PRIVATE_SENTINEL'), false);
  assert.equal(value.provenanceVerified, false);
  assert.equal(value.releaseEligible, false);
  f.module.validateClaudeHostBindingV1(value);
});
test('version probe timeout cleans up its owned long-lived descendant', mac, async t => {
  const f = await fixture(t);
  const pidFile=path.join(f.directory,'child.pid');
  await writeFile(path.join(f.bin,'claude'), `#!/bin/sh\n/bin/sleep 120 &\necho $! > '${pidFile}'\nwait\n`);
  const value=await observation(f);assert.equal(value.result,'HOLD');
  const pid=Number((await readFile(pidFile,'utf8')).trim());
  assert.throws(() => process.kill(pid,0), { code:'ESRCH' });
});
test('self-declared trusted/model/release/installed identities are rejected even with a valid digest', mac, async t => {
  const f=await fixture(t), value=await observation(f);
  for (const mutate of [v=>{v.provenanceVerified=true;},v=>{v.releaseEligible=true;},v=>{v.host.modelIdentity='requested-sonnet';},v=>{v.source.installedSourceState='verified';},v=>{v.trustedSigner='self';},v=>{v.source.bundleFileCount=4097;}]) {
    const v=structuredClone(value);mutate(v);assert.throws(() => f.module.validateClaudeHostBindingV1(rewriteDigest(v)));
  }
  const v=structuredClone(value);v.source.helperDigest='f'.repeat(64);assert.throws(()=>f.module.validateClaudeHostBindingV1(v),/digest mismatch/);
});
test('caller cannot override the executing bundle or pin identity through options', mac, async t => {
  const f=await fixture(t);
  await assert.rejects(f.module.observeClaudeHostBindingV1({osId:'macos',env:f.env,sourceRoot:'/tmp/other'}),/unsupported fields/);
  f.env.SBW_PLUGIN_ROOT='/tmp/other';f.env.SBW_CLAUDE_VERSION='99.0.0';
  const value=await observation(f);assert.equal(value.result,'PASS');assert.equal(value.host.reportedVersion,'2.1.292');
});
test('shipped CLI calls binding module and rejects source/receipt overrides', mac, async t => {
  const f=await fixture(t), command=path.join(f.bundle,'scripts/sbw.mjs');
  const env={...process.env,PATH:f.bin,SBW_STATE_ROOT:path.join(f.directory,'state')};
  const good=spawnSync(process.execPath,[command,'host','binding','claude-code','--os','macos'],{env,encoding:'utf8',timeout:30000});
  assert.equal(good.status,0,good.stderr);const value=JSON.parse(good.stdout);assert.equal(value.result,'PASS');assert.equal(value.host.reportedVersion,'2.1.292');
  for(const args of [['--write-receipt'],['--source-root','/tmp'],['--os','macos','--model','x']]) {
    const bad=spawnSync(process.execPath,[command,'host','binding','claude-code',...args],{env,encoding:'utf8',timeout:30000});assert.notEqual(bad.status,0);
  }
});

test('CLI HOLD prints the observation and exits nonzero', mac, async t => {
  const f=await fixture(t);await rm(path.join(f.bundle,'.claude-plugin/plugin.json'));
  const r=spawnSync(process.execPath,[path.join(f.bundle,'scripts/sbw.mjs'),'host','binding','claude-code','--os','macos'], {env:{...process.env,PATH:f.bin,SBW_STATE_ROOT:path.join(f.directory,'state')},encoding:'utf8',timeout:30000});
  assert.equal(r.status,2,r.stderr);const v=JSON.parse(r.stdout);assert.equal(v.result,'HOLD');assert.ok(v.blockers.includes('host-binding-manifest-unavailable'));
});
for(const [label, count, directories] of [['empty directories',4097,true],['single-directory entries',8193,false]]) {
  test(`bounded inventory rejects too many ${label}`, mac, async t => {
    const f=await fixture(t), base=path.join(f.bundle,'enumeration-bound');await mkdir(base);
    for(let start=0;start<count;start+=128)await Promise.all(Array.from({length:Math.min(128,count-start)},(_,offset)=>directories?mkdir(path.join(base,String(start+offset))):writeFile(path.join(base,String(start+offset)),'')));
    const v=await observation(f);assert.equal(v.result,'HOLD');assert.ok(v.blockers.includes('host-binding-bundle-limit-exceeded'));
  });
}

// Real filesystem fixtures and test-only VM boundaries never qualify a host.
async function markExecution(f) {
  const marker = path.join(f.directory, 'executed');
  await writeFile(path.join(f.bin, 'claude'), `#!/bin/sh\n/usr/bin/touch '${marker}'\nprintf '2.1.292 (Claude Code)\\n'\n`);
  return marker;
}
async function notExecuted(f, marker, blocker) {
  const value = await observation(f);
  assert.equal(value.result, 'HOLD');
  assert.equal(value.execution.attempted, false);
  assert.ok(value.blockers.includes(blocker), JSON.stringify(value.blockers));
  assert.equal(await lstat(marker).then(() => true, () => false), false);
}
for (const [entryDepth, allowed] of [[64, true], [65, false]]) {
  test(`bundle traversal depth ${entryDepth} ${allowed ? 'remains observable' : 'rejects before execution'}`, mac, async t => {
    const f = await fixture(t), marker = await markExecution(f);
    let parent = f.bundle;
    // The bundle root is depth 0; the final file is an inventory entry too.
    for (let depth = 1; depth < entryDepth; depth++) {
      parent = path.join(parent, 'd');
      await mkdir(parent);
    }
    await writeFile(path.join(parent, 'leaf'), 'bounded');
    if (!allowed) {
      await notExecuted(f, marker, 'host-binding-bundle-limit-exceeded');
      return;
    }
    const value = await observation(f);
    assert.equal(value.result, 'PASS');
    assert.equal(value.execution.attempted, true);
    assert.equal(value.execution.groupTerminated, true);
    assert.equal(value.provenanceVerified, false);
    assert.equal(value.releaseEligible, false);
    assert.equal(await lstat(marker).then(() => true, () => false), true);
  });
}
for (const [label, relative, directory] of [['bundle root', '', true], ['bundle directory', 'config', true], ['bundle file', 'scripts/sbw.mjs', false]]) {
  for (const [name, bit] of [['group write', 0o020], ['other write', 0o002], ['special bit', 0o1000]]) {
    test(`${label} ${name} rejects before executing`, mac, async t => {
      const f = await fixture(t), marker = await markExecution(f);
      await chmod(path.join(f.bundle, relative), (directory ? 0o755 : 0o644) | bit);
      await notExecuted(f, marker, 'host-binding-bundle-unsafe');
    });
  }
}
for (const [label, where, mode] of [['CLI group write', 'cli', 0o775], ['CLI other write', 'cli', 0o757], ['CLI special bit', 'cli', 0o4755], ['PATH parent write', 'bin', 0o775], ['private ancestor write', 'directory', 0o770], ['private ancestor not 0700', 'directory', 0o755], ['other sticky parent', 'bin', 0o1755]]) {
  test(`${label} rejects without an execution marker`, mac, async t => {
    const f = await fixture(t), marker = await markExecution(f);
    await chmod(where === 'cli' ? path.join(f.bin, 'claude') : f[where], mode);
    await notExecuted(f, marker, where === 'directory' ? 'host-binding-bundle-unsafe' : 'host-binding-executable-unsafe');
  });
}
async function directLeaf(f) {
  const versions = path.join(f.directory, 'versions'); await mkdir(versions);
  const target = path.join(versions, '2.1.292');
  await rename(path.join(f.bin, 'claude'), target);
  await symlink('../versions/2.1.292', path.join(f.bin, 'claude'));
  return { versions, target };
}
test('one direct native-style CLI leaf link remains observable', mac, async t => {
  const f = await fixture(t), { target } = await directLeaf(f), value = await observation(f);
  assert.equal(value.result, 'PASS'); assert.equal(value.host.executablePath, target);
  assert.equal(value.provenanceVerified, false); assert.equal(value.releaseEligible, false);
});
test('canonical target parent write rejects before execution', mac, async t => {
  const f = await fixture(t), marker = await markExecution(f), { versions } = await directLeaf(f);
  await chmod(versions, 0o775);
  await notExecuted(f, marker, 'host-binding-executable-unsafe');
});
test('a PATH parent link cannot be hidden by realpath', mac, async t => {
  const f = await fixture(t), marker = await markExecution(f), alias = path.join(f.directory, 'bin-alias');
  await symlink(f.bin, alias); f.env.PATH = alias;
  await notExecuted(f, marker, 'host-binding-executable-unsafe');
});
test('multiple CLI leaf links are rejected', mac, async t => {
  const f = await fixture(t), marker = await markExecution(f), { target } = await directLeaf(f);
  const intermediate = path.join(f.directory, 'versions/intermediate'); await symlink(target, intermediate);
  await rm(path.join(f.bin, 'claude')); await symlink(intermediate, path.join(f.bin, 'claude'));
  await notExecuted(f, marker, 'host-binding-executable-unsafe');
});
test('a link target cannot normalize away a named symlink parent', mac, async t => {
  const f = await fixture(t), marker = await markExecution(f), { target } = await directLeaf(f);
  await symlink(path.dirname(target), path.join(f.bin, 'named-parent'));
  await rm(path.join(f.bin, 'claude'));
  await symlink('named-parent/../versions/2.1.292', path.join(f.bin, 'claude'));
  await notExecuted(f, marker, 'host-binding-executable-unsafe');
});
test('a direct shared-temp executable has no private ancestry fence', mac, async t => {
  const f = await fixture(t), marker = await markExecution(f), target = `${f.directory}-direct-cli`;
  await writeFile(target, await readFile(path.join(f.bin, 'claude')), { mode: 0o755, flag: 'wx' });
  t.after(() => rm(target, { force: true }));
  await rm(path.join(f.bin, 'claude')); await symlink(target, path.join(f.bin, 'claude'));
  await notExecuted(f, marker, 'host-binding-executable-unsafe');
});

async function vmBoundary(f, mutate = async () => {}, alterStat = value => value) {
  const vm = await import('node:vm'), fs = await import('node:fs/promises');
  assert.equal(typeof vm.SourceTextModule, 'function', 'Run these acceptance cases with --experimental-vm-modules');
  const context = vm.createContext({ process, Buffer, console });
  let runnerCalls = 0;
  const hosts = await import(pathToFileURL(path.join(f.bundle, 'scripts/lib/hosts.mjs')));
  const namespaces = {
    'node:fs': { constants: (await import('node:fs')).constants },
    'node:fs/promises': { ...fs,
      lstat: async (target, options) => alterStat(await fs.lstat(target, options), target),
      mkdtemp: async (...args) => { const home = await fs.mkdtemp(...args); await mutate(); return home; } },
    'node:crypto': { createHash: (await import('node:crypto')).createHash },
    'node:os': { default: os }, 'node:path': { default: path },
    './core.mjs': { digestObject, pluginRoot: () => f.bundle, nowIso: () => new Date().toISOString(),
      execBoundProcess: async () => { runnerCalls++; return { code: 0, signal: null, groupTerminated: true, stdout: '2.1.292 (Claude Code)\n' }; } },
    './hosts.mjs': { loadHostSupportRegistry: hosts.loadHostSupportRegistry }
  };
  const module = new vm.SourceTextModule(await readFile(path.join(f.bundle, 'scripts/lib/claude-host-binding-v1.mjs'), 'utf8'), { context });
  await module.link(specifier => {
    const values = namespaces[specifier]; assert.ok(values, specifier);
    return new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context });
  });
  await module.evaluate();
  const value = await module.namespace.observeClaudeHostBindingV1({ osId: 'macos', env: f.env });
  return { value, runnerCalls };
}
for (const [label, mutate] of [
  ['CLI replacement', async f => { const file = path.join(f.bin, 'claude'); await rename(file, `${file}-old`); await writeFile(file, '#!/bin/sh\nprintf "2.1.292 (Claude Code)\\n"\n', { mode: 0o755 }); }],
  ['CLI mode change', f => chmod(path.join(f.bin, 'claude'), 0o775)],
  ['PATH parent replacement', async f => { await rename(f.bin, `${f.bin}-old`); await mkdir(f.bin); await cp(path.join(`${f.bin}-old`, 'claude'), path.join(f.bin, 'claude')); }],
  ['bundle directory mode change', f => chmod(path.join(f.bundle, 'config'), 0o775)],
  ['leaf link retarget', async f => { const { target } = f.link; const second = `${target}-second`; await cp(target, second); await rm(path.join(f.bin, 'claude')); await symlink(second, path.join(f.bin, 'claude')); }]
]) {
  test(`pre-run ${label} invokes no runner`, mac, async t => {
    const f = await fixture(t); if (label === 'leaf link retarget') f.link = await directLeaf(f);
    const { value, runnerCalls } = await vmBoundary(f, () => mutate(f));
    assert.equal(value.result, 'HOLD'); assert.equal(value.execution.attempted, false); assert.equal(runnerCalls, 0);
  });
}
test('unrelated shared-temp sibling creation does not change bound parents', mac, async t => {
  const f = await fixture(t); let sibling;
  const { value, runnerCalls } = await vmBoundary(f, async () => { sibling = await mkdtemp('/private/tmp/claude-binding-unrelated-'); });
  if (sibling) await rm(sibling, { recursive: true, force: true });
  assert.equal(value.result, 'PASS'); assert.equal(runnerCalls, 1); assert.equal(value.provenanceVerified, false);
});
test('a foreign bundle owner is rejected without changing host ownership', mac, async t => {
  const f = await fixture(t);
  const { value, runnerCalls } = await vmBoundary(f, undefined, (info, target) => target === f.bundle
    ? new Proxy(info, { get: (object, key) => key === 'uid' ? 31337n : Reflect.get(object, key) }) : info);
  assert.equal(value.result, 'HOLD'); assert.equal(value.execution.attempted, false); assert.equal(runnerCalls, 0);
});
test('a simulated non-root shared-temp owner is rejected', mac, async t => {
  const f = await fixture(t);
  const { value, runnerCalls } = await vmBoundary(f, undefined, (info, target) => target === '/private/tmp'
    ? new Proxy(info, { get: (object, key) => key === 'uid' ? 31337n : Reflect.get(object, key) }) : info);
  assert.equal(value.result, 'HOLD'); assert.equal(runnerCalls, 0);
});
test('directory mode changes during the probe are still rejected', mac, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.bin, 'claude'), `#!/bin/sh\n/bin/chmod 0775 '${path.join(f.bundle, 'config')}'\nprintf '2.1.292 (Claude Code)\\n'\n`);
  const value = await observation(f); assert.equal(value.result, 'HOLD'); assert.equal(value.execution.attempted, true);
});
