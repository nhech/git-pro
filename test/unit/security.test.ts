import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { writeFile, mkdir, symlink, rename } from 'node:fs/promises';
import { PathPolicy, containsPath } from '../../src/security/paths';
import { validateBranchName, validateOid } from '../../src/security/refs';
import { redact } from '../../src/security/redaction';
import { readEnvironment } from '../../src/git/git-executor';
import { buildReadCommand } from '../../src/git/command-builders';
import { fixture } from '../fixtures/repository-fixture';

test('ancestor check has separator boundaries', () => {
  assert.equal(containsPath(path.resolve('repo'), path.resolve('repo-other')), false);
  assert.equal(containsPath(path.resolve('repo'), path.resolve('repo', 'nested')), true);
});
test('paths reject traversal, scope escape, symlink and revoked trust', async () => {
  const f = await fixture(); let trusted = true;
  try {
    const policy = new PathPolicy(() => [f.root], () => trusted);
    await assert.rejects(policy.authorizeRoot(f.home), /outside/);
    await assert.rejects(policy.authorizeFile(f.root, '../home'), /Invalid/);
    await writeFile(path.join(f.root, 'literal.txt'), 'safe');
    assert.equal(await policy.authorizeFile(f.root, 'literal.txt'), path.join(f.root, 'literal.txt'));
    await assert.rejects(policy.authorizeFile(f.root, '\0'), /Invalid/);
    await mkdir(path.join(f.home, 'outside'));
    await symlink(path.join(f.home, 'outside'), path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(policy.authorizeFile(f.root, 'linked/missing.txt'), /Symlink/);
    trusted = false; await assert.rejects(policy.authorizeRoot(f.root), /trusted/);
  } finally { await f.cleanup(); }
});
test('refs and OIDs cannot become command options', () => {
  for (const name of ['--upload-pack=x', 'bad name', '../escape', 'a.lock', 'a//b', 'a@{b', 'a\nb']) assert.throws(() => validateBranchName(name));
  assert.equal(validateBranchName('feature/hello'), 'feature/hello');
  assert.equal(validateOid('a'.repeat(64)).length, 64); assert.throws(() => validateOid('--all'));
});

test('worktree grants pin one canonical path and parent identity, and expire on revoked trust',async()=>{
  const f=await fixture();let trusted=true;try{
    const policy=new PathPolicy(()=>[f.root],()=>trusted),parent=path.join(f.parent,'approved-parent');await mkdir(parent);
    const destination=path.join(parent,'linked'),grant=await policy.approveWorktreeDestination(destination);
    assert.equal(await policy.authorizeWorktreeDestination(destination,grant),destination);
    await assert.rejects(policy.authorizeWorktreeDestination(path.join(parent,'other'),grant),/does not match/);
    await assert.rejects(new PathPolicy(()=>[f.root],()=>true).authorizeWorktreeDestination(destination,grant),/expired/);
    const moved=path.join(f.parent,'moved-parent');assert.ok(containsPath(f.parent,parent)&&containsPath(f.parent,moved));await rename(parent,moved);await mkdir(parent);
    await assert.rejects(policy.authorizeWorktreeDestination(destination,grant),/parent changed/);
    const fresh=await policy.approveWorktreeDestination(destination);trusted=false;await assert.rejects(policy.authorizeWorktreeDestination(destination,fresh),/trusted/);
  }finally{await f.cleanup();}
});
test('secret sentinels removed from URLs, query, headers and errors', () => {
  const secret = 'SENTINEL_SECRET';
  const safe = redact(`https://user:${secret}@example.test/a?token=${secret}&x=1#${secret}\nAuthorization: Bearer ${secret}\npassword=${secret}`);
  assert.equal(safe.includes(secret), false); assert.match(safe, /redacted/);
});
test('ambient Git overrides stripped; trusted SSH configuration preserved', () => {
  const env = readEnvironment({ GIT_DIR: 'bad', GIT_WORK_TREE: 'bad', GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'secret', GIT_SSH_COMMAND: 'ssh', HOME: 'home' });
  assert.equal(env.GIT_DIR, undefined); assert.equal(env.GIT_CONFIG_VALUE_0, undefined);
  assert.equal(env.HOME, 'home'); assert.equal(env.GIT_SSH_COMMAND, 'ssh'); assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});
test('typed read builder rejects forged marker and arbitrary commands', () => {
  assert.deepEqual(buildReadCommand({ kind: 'status' }).slice(-5), ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']);
  assert.throws(() => buildReadCommand({ kind: 'marker', marker: '../secret' } as never));
  assert.throws(() => buildReadCommand({ kind: 'push' } as never));
});
