import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { GitExecutor } from '../../src/git/git-executor';
import { GitFailure } from '../../src/git/git-error-parser';
import { parseStatus } from '../../src/git/git-parser';
import { PathPolicy } from '../../src/security/paths';
import { RepositoryRegistry } from '../../src/repositories/repository-registry';
import { discoverRepositories } from '../../src/repositories/repository-discovery';
import { RepositoryStore } from '../../src/state/repository-store';
import { silentLogger } from '../../src/utils/logging';
import { Emitter } from '../../src/utils/events';
import { fixture, gitExecutable } from '../fixtures/repository-fixture';

test('real Git status: unborn, staged, working, rename, external checkout', async () => {
  const f = await fixture(); const executor = new GitExecutor(gitExecutable, new PathPolicy(() => [f.parent], () => true), silentLogger, undefined, f.env);
  try {
    let status = parseStatus((await executor.read(f.root, { kind: 'status' })).stdout);
    assert.equal(status.oid, undefined); assert.equal(status.head, 'main');
    await writeFile(path.join(f.root, 'name with spaces.txt'), 'initial\n'); f.git(['add', '--', 'name with spaces.txt']);
    status = parseStatus((await executor.read(f.root, { kind: 'status' })).stdout); assert.equal(status.changes[0]?.group, 'staged');
    f.git(['commit', '-m', 'initial']); f.git(['mv', 'name with spaces.txt', 'renamed.txt']);
    await writeFile(path.join(f.root, 'renamed.txt'), 'initial\nworking\n');
    status = parseStatus((await executor.read(f.root, { kind: 'status' })).stdout);
    assert.equal(status.changes[0]?.originalPath, 'name with spaces.txt'); assert.equal(status.changes.length, 2);
    f.git(['switch', '-c', 'feature/test']);
    assert.equal(parseStatus((await executor.read(f.root, { kind: 'status' })).stdout).head, 'feature/test');
  } finally { executor.dispose(); await f.cleanup(); }
});
test('registry detects multiple/nested repos and linked worktree common directory', async () => {
  const f = await fixture(); const changed = new Emitter<void>();
  const policy = new PathPolicy(() => [f.parent], () => true); const executor = new GitExecutor(gitExecutable, policy, silentLogger, undefined, f.env);
  const store = new RepositoryStore(); const registry = new RepositoryRegistry(policy, executor, store, silentLogger, 60_000);
  try {
    await writeFile(path.join(f.root, 'base.txt'), 'base'); f.git(['add', '.']); f.git(['commit', '-m', 'base']);
    const nested = path.join(f.root, 'nested'); await mkdir(nested); f.git(['init', '-b', 'main'], nested);
    await writeFile(path.join(nested, 'inner.txt'), 'inner');
    const worktree = path.join(f.parent, 'linked'); f.git(['worktree', 'add', '-b', 'linked', worktree]);
    await registry.sync([f.root, nested, worktree].map(root => ({ root, onDidChange: changed.event })));
    assert.equal(registry.list().length, 3);
    const main = registry.list().find(repo => repo.root === f.root)!;
    const linked = registry.list().find(repo => repo.root === worktree)!;
    assert.equal(main.commonDir, linked.commonDir); assert.notEqual(main.gitDir, linked.gitDir);
    assert.equal((await registry.resolveFile(path.join(nested, 'inner.txt')))?.root, nested);
    f.git(['switch', '-c', 'external']); await registry.refresh(main.id); assert.equal(store.get(main.id)?.head, 'external');
    await registry.sync([]); assert.equal(registry.list().length, 0); assert.equal(store.get(main.id), undefined);
  } finally { registry.dispose(); executor.dispose(); store.dispose(); changed.dispose(); await f.cleanup(); }
});
test('bounded discovery finds nested .git and ignores dependency directories', async () => {
  const f = await fixture();
  try {
    const nested = path.join(f.root, 'nested'); await mkdir(nested); f.git(['init', '-b', 'main'], nested);
    const ignored = path.join(f.root, 'node_modules', 'ignored'); await mkdir(ignored, { recursive: true }); f.git(['init', '-b', 'main'], ignored);
    const roots = await discoverRepositories([f.root], new PathPolicy(() => [f.root], () => true));
    assert.deepEqual(roots.sort(), [f.root, nested].sort());
    assert.equal((await discoverRepositories([f.root], new PathPolicy(() => [f.root], () => true), { maxDirectories: 1 })).length, 1);
  } finally { await f.cleanup(); }
});
test('untrusted and outside roots rejected before process spawn', async () => {
  const f = await fixture(); let launched = false;
  const executor = new GitExecutor(gitExecutable, new PathPolicy(() => [f.root], () => false), silentLogger,
    () => { launched = true; throw new Error('must not launch'); });
  try { await assert.rejects(executor.read(f.root, { kind: 'version' }), /trusted/); assert.equal(launched, false); }
  finally { executor.dispose(); await f.cleanup(); }
});
test('disposal cancels an in-flight read and rejects later reads', async () => {
  const f = await fixture();
  const executor = new GitExecutor(gitExecutable, new PathPolicy(() => [f.root], () => true), silentLogger,
    () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  try {
    const pending = executor.read(f.root, { kind: 'status' });
    const stopped = assert.rejects(pending, /cancelled|disposed/);
    await new Promise(resolve => setTimeout(resolve, 100)); executor.dispose(); await stopped;
    await assert.rejects(executor.read(f.root, { kind: 'status' }), /disposed/);
  } finally { executor.dispose(); await f.cleanup(); }
});
test('closed repository cannot publish a stale in-flight snapshot', async () => {
  const f = await fixture(); const changes = new Emitter<void>();
  const executor = new GitExecutor(gitExecutable, new PathPolicy(() => [f.parent], () => true), silentLogger, undefined, f.env);
  const store = new RepositoryStore(); const registry = new RepositoryRegistry(new PathPolicy(() => [f.parent], () => true), executor, store, silentLogger, 60_000);
  try {
    await registry.sync([{ root: f.root, onDidChange: changes.event }]);
    const id = registry.list()[0]!.id;
    const reading = registry.refresh(id); await registry.sync([]); await reading;
    assert.equal(store.get(id), undefined); assert.equal(registry.active, undefined);
  } finally { registry.dispose(); executor.dispose(); store.dispose(); changes.dispose(); await f.cleanup(); }
});
for (const mode of ['timeout', 'cancelled', 'output-limit'] as const) {
  test(`executor ${mode} stops owned process and does not report success`, async () => {
    const f = await fixture(); let childPid: number | undefined;
    const launch = () => {
      const child = spawn(process.execPath, ['-e', mode === 'output-limit' ? 'process.stdout.write("x".repeat(4096));setInterval(()=>{},1000)' : 'setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      childPid = child.pid; return child;
    };
    const executor = new GitExecutor(gitExecutable, new PathPolicy(() => [f.root], () => true), silentLogger, launch);
    const controller = new AbortController();
    const timer = mode === 'cancelled' ? setTimeout(() => controller.abort(), 100) : undefined;
    try {
      await assert.rejects(executor.read(f.root, { kind: 'status' }, { timeoutMs: mode === 'timeout' ? 100 : 5000, maxOutputBytes: 128, signal: controller.signal }),
        (error: unknown) => error instanceof GitFailure && error.kind === mode);
      assert.ok(childPid); assert.throws(() => process.kill(childPid!, 0));
    } finally { if (timer) clearTimeout(timer); executor.dispose(); await f.cleanup(); }
  });
}
test('executor logs operation metadata and strips arbitrary stderr secrets', async () => {
  const f = await fixture(); const lines: string[] = [];
  const executor = new GitExecutor(gitExecutable, new PathPolicy(() => [f.root], () => true),
    { info: line => lines.push(line), error: line => lines.push(line) },
    () => spawn(process.execPath, ['-e', 'process.stderr.write("Authentication failed https://user:SECRET@host");process.exit(1)'], { stdio: ['ignore', 'pipe', 'pipe'] }));
  try {
    await assert.rejects(executor.read(f.root, { kind: 'status' }), (error: unknown) => error instanceof GitFailure && !error.message.includes('SECRET'));
    assert.equal(lines.join().includes('SECRET'), false);
  } finally { executor.dispose(); await f.cleanup(); }
});

test('optional HEAD resolution accepts only empty exit1 for its own fixed recipe',async()=>{
  const f=await fixture();let output='',diagnostic='',exitCode=1;
  const executor=new GitExecutor(gitExecutable,new PathPolicy(()=>[f.root],()=>true),silentLogger,()=>spawn(process.execPath,['-e',`process.stdout.write(${JSON.stringify(output)});process.stderr.write(${JSON.stringify(diagnostic)});process.exit(${exitCode})`],{stdio:['ignore','pipe','pipe'],windowsHide:true}));
  try{
    assert.equal((await executor.read(f.root,{kind:'historyHead'})).exitCode,1);
    await assert.rejects(executor.read(f.root,{kind:'ref',ref:'HEAD'}));
    for(const sample of [{out:'unexpected',err:'',code:1},{out:'',err:'diagnostic',code:1},{out:'',err:'',code:128}]){
      output=sample.out;diagnostic=sample.err;exitCode=sample.code;await assert.rejects(executor.read(f.root,{kind:'historyHead'}));
    }
  }finally{executor.dispose();await f.cleanup();}
});
test('Windows cancellation terminates descendants in the owned PID tree', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture(); let descendantPid: number | undefined;
  const executor = new GitExecutor(gitExecutable, new PathPolicy(() => [f.root], () => true), silentLogger, () => {
    const child = spawn(process.execPath, ['-e', 'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});process.stdout.write(String(c.pid));setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout?.on('data', (data: Buffer) => { descendantPid = Number(data.toString()); }); return child;
  });
  try {
    await assert.rejects(executor.read(f.root, { kind: 'status' }, { timeoutMs: 500 }), (error: unknown) => error instanceof GitFailure && error.kind === 'timeout');
    assert.ok(descendantPid); assert.throws(() => process.kill(descendantPid!, 0));
  } finally { executor.dispose(); await f.cleanup(); }
});
