import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ExtensionDiagnostics } from '../../src/extension';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor<T>(probe: () => T | undefined | false, what: string, timeout = 15_000): Promise<T> {
  for (const start = Date.now(); ;) {
    const value = probe(); if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

/**
 * A binary file that is staged and then changed again cannot be shown by Git Pro's text diff. Opening its change must not end in "Binary revision: open the file through native
 * Source Control": it opens in the built-in Source Control's own diff (a tab named "<file> (Working Tree)"), on VS Code 1.100.0 and the current stable. `root` is the harness-owned
 * repository; the file is removed from the index and the disk again before returning.
 */
export async function verifyBinaryDiffHost(api: ExtensionDiagnostics, root: string): Promise<void> {
  assert.ok(api.activeRepository() && root.includes('git-pro-host-'), 'The binary diff check runs in the owned fixture');
  const name = 'binary-diff.bin', file = path.join(root, name);
  const git = (args: string[]) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); };
  const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
  try {
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]));
    git(['add', '--', name]);
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x09, 0x08, 0x00, 0x07]));
    await vscode.commands.executeCommand('git.refresh'); await vscode.commands.executeCommand('gitPro.refresh');
    const change = await waitFor(() => api.activeSnapshot()?.changes.find(item => item.path === name && item.group === 'working'), 'the binary file in the working tree group');
    await vscode.commands.executeCommand('gitPro.diff', { kind: 'file', repositoryId: api.activeRepository(), change });
    const opened = await waitFor(() => tabs().find(tab => tab.label.startsWith(`${name} (`)), 'the built-in Source Control diff of the binary file');
    assert.ok(!opened.label.includes('↔'), 'it is the built-in diff, not a Git Pro text diff');
    console.log(`Git Pro binary diff host passed: opening the change of a binary file opened the built-in diff "${opened.label}".`);
  } finally {
    const owned = tabs().filter(tab => tab.label.startsWith(`${name} (`));
    if (owned.length) await vscode.window.tabGroups.close(owned, true);
    git(['reset', '-q', '--', name]); await rm(file, { force: true });
    await vscode.commands.executeCommand('git.refresh'); await vscode.commands.executeCommand('gitPro.refresh');
  }
}
