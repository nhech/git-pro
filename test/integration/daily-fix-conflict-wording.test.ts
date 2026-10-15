import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, gitExecutable } from '../fixtures/repository-fixture';
import { GitExecutor } from '../../src/git/git-executor';
import { GitFailure, classifyGitDiagnostic, parseMutationError } from '../../src/git/git-error-parser';
import { PathPolicy } from '../../src/security/paths';
import { isConflictFailure } from '../../src/conflicts/surfaces';
import { recoveryFor } from '../../src/utils/recovery';
import { silentLogger } from '../../src/utils/logging';

type Fixture = Awaited<ReturnType<typeof fixture>>;
interface Output { readonly stdout: string; readonly stderr: string; readonly code: number | null }
/** Git as the executor runs it (C locale, no editor), with both streams kept apart. */
function run(f: Fixture, args: string[]): Output {
  const result = spawnSync(gitExecutable, args, { cwd: f.root, env: { ...f.env, LC_ALL: 'C', GIT_EDITOR: 'false', GIT_MERGE_AUTOEDIT: 'no' }, encoding: 'utf8', windowsHide: true });
  return { stdout: result.stdout, stderr: result.stderr, code: result.status };
}
async function commit(f: Fixture, content: string, message: string): Promise<string> {
  await writeFile(path.join(f.root, 'file.txt'), content); f.git(['add', 'file.txt']); f.git(['commit', '-m', message]); return f.git(['rev-parse', 'HEAD']).trim();
}
/** main and feature both change file.txt from one base. */
async function diverged(f: Fixture): Promise<{ feature: string; main: string }> {
  await commit(f, 'base\n', 'base'); f.git(['checkout', '-b', 'feature']); const feature = await commit(f, 'feature\n', 'feature');
  f.git(['checkout', 'main']); return { feature, main: await commit(f, 'main\n', 'main') };
}
/** What the built-in Git API rejects with: the message is generic and stderr carries Git's text. */
const apiError = (output: Output) => Object.assign(new Error('Failed to execute git'), { stderr: output.stderr, exitCode: output.code });
const conflictRecovery = (error: unknown) => recoveryFor(error).command === 'gitPro.conflicts.open' && /^Git reported unresolved conflicts\./.test(recoveryFor(error).message);

test('real conflict output from merge, rebase, cherry-pick, revert and stash apply, and refusals on an unmerged index, is a conflict', async () => {
  const outputs: { label: string; kind: string; output: Output }[] = [];
  for (const scenario of ['merge', 'rebase', 'cherryPick', 'revert', 'stashApply'] as const) {
    const f = await fixture();
    try {
      const { feature, main } = await diverged(f);
      if (scenario === 'merge') outputs.push({ label: scenario, kind: scenario, output: run(f, ['merge', '--no-ff', feature]) });
      else if (scenario === 'rebase') { f.git(['checkout', 'feature']); outputs.push({ label: scenario, kind: scenario, output: run(f, ['rebase', main]) }); }
      else if (scenario === 'cherryPick') outputs.push({ label: scenario, kind: scenario, output: run(f, ['cherry-pick', feature]) });
      else if (scenario === 'revert') { await commit(f, 'later\n', 'later'); outputs.push({ label: scenario, kind: scenario, output: run(f, ['revert', '--no-edit', main]) }); }
      else { await writeFile(path.join(f.root, 'file.txt'), 'stashed\n'); f.git(['stash', 'push']); await commit(f, 'other\n', 'other'); outputs.push({ label: scenario, kind: scenario, output: run(f, ['stash', 'apply']) }); }
      if (scenario === 'merge') {
        outputs.push({ label: 'commit on an unmerged index', kind: 'commitFile', output: run(f, ['commit', '-m', 'x']) });
        outputs.push({ label: 'checkout on an unmerged index', kind: 'checkout', output: run(f, ['checkout', 'feature']) });
        outputs.push({ label: 'restore of an unmerged path', kind: 'discard', output: run(f, ['restore', '--worktree', '--', 'file.txt']) });
      }
    } finally { await f.cleanup(); }
  }
  assert.deepEqual(outputs.map(item => item.label), ['merge', 'commit on an unmerged index', 'checkout on an unmerged index', 'restore of an unmerged path', 'rebase', 'cherryPick', 'revert', 'stashApply']);
  for (const { label, kind, output } of outputs) {
    assert.notEqual(output.code, 0, `${label} failed in Git`);
    // The executor reads merge-family stdout and stderr; merge and stash apply write their conflicts to stdout only.
    assert.equal(parseMutationError(kind, Buffer.from(output.stdout), output.stderr, output.code).kind, 'conflict', `${label}: ${JSON.stringify(output)}`);
    if (!output.stderr.trim()) { assert.equal(classifyGitDiagnostic(output.stdout), 'conflict', `${label} stdout`); continue; }
    assert.equal(classifyGitDiagnostic(output.stderr), 'conflict', `${label} stderr: ${output.stderr}`);
    assert.ok(conflictRecovery(apiError(output)) && isConflictFailure(apiError(output)), `${label}: built-in Git API error`);
  }
});

test('hook output and branch names that merely contain "conflict" are not conflicts, and recovery keeps the real error reachable', async () => {
  const f = await fixture(), executor = new GitExecutor(gitExecutable, new PathPolicy(() => [f.parent], () => true), silentLogger, undefined, f.env);
  try {
    await commit(f, 'base\n', 'base'); await writeFile(path.join(f.root, 'file.txt'), 'changed\n');
    const plain = (error: unknown) => {
      const recovery = recoveryFor(error);
      return !isConflictFailure(error) && recovery.label === 'Show Output' && recovery.command === 'gitPro.showOutput' && !/conflicts/.test(recovery.message);
    };
    for (const hook of ['echo "eslint: src/conflicts/panel.ts:3 no-unused-vars" >&2', 'echo "Check for merge conflicts....Failed" >&2; echo "src/a.ts:3: Merge conflict string \'<<<<<<< \' found" >&2',
      'echo "2 unmerged migrations in db/conflict-resolution/" >&2']) {
      await writeFile(path.join(f.root, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n${hook}\nexit 1\n`, { mode: 0o755 });
      const failure = await executor.mutate(f.root, { kind: 'commitFile', paths: ['file.txt'], message: 'blocked by a hook' }).then(() => undefined, (error: unknown) => error);
      assert.ok(failure instanceof GitFailure && failure.kind === 'unknown', `${hook}: ${String(failure)}`);
      assert.ok(plain(failure), hook);
      // The same stderr through the built-in Git API (Commit uses it).
      assert.ok(plain(apiError({ stdout: '', stderr: failure.message, code: 1 })), `${hook} via the API`);
    }
    f.git(['branch', 'fix-merge-conflict-ui']);
    const worktree = await executor.mutate(f.root, { kind: 'worktreeAdd', destination: path.join(f.parent, 'wt'), oid: f.git(['rev-parse', 'HEAD']).trim(), branch: 'fix-merge-conflict-ui' }).then(() => undefined, (error: unknown) => error);
    assert.ok(worktree instanceof GitFailure && worktree.kind === 'unknown' && /already exists/.test(worktree.message), String(worktree));
    assert.ok(plain(worktree));
  } finally { executor.dispose(); await f.cleanup(); }
});
