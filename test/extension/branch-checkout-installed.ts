import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ExtensionDiagnostics } from '../../src/extension';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!condition()) { assert.ok(Date.now() < deadline, message); await delay(25); }
}

export async function run(): Promise<void> {
  const output = process.env.GIT_PRO_BRANCH_CHECKOUT_OUTPUT; assert.ok(output);
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; assert.ok(folder);
  const root = await fs.realpath(folder), temp = await fs.realpath(tmpdir());
  assert.equal(path.dirname(path.dirname(root)), temp);
  assert.match(path.basename(path.dirname(root)), /^git-pro-host-/);
  assert.equal(path.basename(root), 'workspace');
  const extension = vscode.extensions.getExtension<ExtensionDiagnostics>('nhech.git-pro'); assert.ok(extension);
  const api = await extension.activate(); assert.ok(api); assert.ok(api.activeRepository());
  const available = await vscode.commands.getCommands(false);
  for (const command of ['gitPro.branchActions', 'gitPro.refresh', 'workbench.action.acceptSelectedQuickOpenItem', 'workbench.action.closeQuickOpen']) assert.ok(available.includes(command), command);
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, env: process.env, shell: false, windowsHide: true });
    assert.equal(result.status, 0, result.stderr.toString()); return result.stdout;
  };
  const text = (args: string[]) => git(args).toString('utf8').trim();
  const snapshot = async () => {
    const files: Record<string, string> = {};
    const walk = async (directory: string) => { for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const file = path.join(directory, entry.name); assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) await walk(file);
      else files[path.relative(root, file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    } };
    await walk(root);
    return { head: text(['rev-parse', 'HEAD']), refs: git(['for-each-ref', '--format=%(refname) %(objectname)']).toString('base64'),
      status: git(['status', '--porcelain=v2', '-z']).toString('base64'), staged: git(['ls-files', '--stage', '-z']).toString('base64'),
      workingDiff: git(['diff', '--binary']).toString('base64'), indexDiff: git(['diff', '--cached', '--binary']).toString('base64'), files,
      rawIndex: createHash('sha256').update(await fs.readFile(path.join(root, '.git/index'))).digest('hex') };
  };
  const reports: unknown[] = [], branch = 'git-pro-native-checkout-fixture'; let created = false;
  const result: Record<string, unknown> = { version: vscode.version, passed: false, originalInstalledCommand: 'gitPro.branchActions',
    originalCommandsReplaced: 0, backendReplaced: false, nativeControlsReplaced: false, physicalInput: false, nativeWindowsTouched: false, reports };
  try {
    assert.equal(text(['symbolic-ref', '--short', 'HEAD']), 'main');
    assert.equal(git(['for-each-ref', `refs/heads/${branch}`]).length, 0);
    git(['add', '--all']); git(['commit', '-m', 'owned native checkout baseline']);
    git(['branch', branch]); created = true;
    await vscode.commands.executeCommand('gitPro.refresh');
    const baseline = await snapshot(); assert.equal(baseline.status, ''); assert.equal(baseline.workingDiff, ''); assert.equal(baseline.indexDiff, '');
    for (const name of [branch, 'main']) {
      assert.equal(text(['status', '--porcelain']), '');
      let settled = false; const started = Date.now();
      const pending = vscode.commands.executeCommand('gitPro.branchActions', { kind: 'branch', repositoryId: api.activeRepository(),
        branch: { name, ref: `refs/heads/${name}`, oid: baseline.head, remote: false, upstream: '', worktree: '' } }).then(() => { settled = true; });
      await delay(250); assert.equal(settled, false, 'Original native action chooser is pending before explicit acceptance');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await until(() => settled, 'Original Checkout action must settle after native acceptance'); await pending;
      await vscode.commands.executeCommand('gitPro.refresh');
      assert.equal(text(['symbolic-ref', '--short', 'HEAD']), name, 'Original installed Checkout changed the branch');
      assert.equal(api.activeSnapshot()?.head, name, 'Production repository snapshot reflects the checkout');
      const after = await snapshot(), { rawIndex: beforeIndex, ...beforeSemantic } = baseline, { rawIndex: afterIndex, ...afterSemantic } = after;
      assert.deepEqual(afterSemantic, beforeSemantic, 'Checkout preserves same-commit files, semantic index, refs, status and diffs');
      reports.push({ branch: name, passed: true, elapsedMs: Date.now() - started, repositoryPreserved: true, pendingBeforeAccept: true,
        rawIndexBefore: beforeIndex, rawIndexAfter: afterIndex, rawIndexEqual: beforeIndex === afterIndex });
    }
    result.passed = true;
    result.note = 'Two original installed command checkouts via genuine native action picker and public programmatic acceptance; elapsed includes a deliberate 250 ms hold. Clean same-commit branch switching only, not dirty smart-checkout or physical/native Windows UX.';
  } catch (error) { result.error = String(error); result.stack = error instanceof Error ? error.stack : undefined; }
  finally {
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    // Only remove the exact fixture branch after successful product return to main.
    if (created && text(['symbolic-ref', '--short', 'HEAD']) === 'main') { git(['branch', '-d', branch]); result.fixtureBranchRemoved = true; }
    else result.fixtureBranchRemoved = false;
    await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  }
  assert.equal(result.passed, true, String(result.error)); console.log(JSON.stringify(result));
}
