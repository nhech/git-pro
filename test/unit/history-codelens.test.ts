import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { PathPolicy, containsPath } from '../../src/security/paths';

test('File History CodeLens is opt-in, scoped, cancelled/stale-safe and contains only a read action', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'git-pro-codelens-unit-')));
  try {
    const repoRoot = path.join(root, 'repo'); await mkdir(repoRoot);
    const file = path.join(repoRoot, 'saved.txt'); await writeFile(file, 'saved\n');
    const outside = path.join(root, 'outside.txt'); await writeFile(outside, 'outside\n');
    let enabled = false, trusted = true, cancelled = false, closedRepo = false, reads = 0;
    const events = new Map<string, () => void>();
    const subscribe = (name: string) => (callback: () => void) => { events.set(name, callback); return { dispose: () => events.delete(name) }; };
    const document = { uri: { scheme: 'file', fsPath: file }, isDirty: false, isClosed: false, version: 1 };
    const workspace = { get isTrusted() { return trusted; }, getConfiguration: () => ({ get: () => enabled }),
      onDidChangeTextDocument: subscribe('document'), onDidCloseTextDocument: subscribe('close'), onDidChangeConfiguration: subscribe('configuration') };
    class CodeLens { constructor(public range: unknown, public command: { command: string; arguments: unknown[] }) {} }
    const vscode = { workspace, CodeLens, Range: class {} };
    const controllerFile = path.resolve(__dirname, '../../src/editor/history-codelens.js');
    const exports: Record<string, unknown> = {}, load = createRequire(controllerFile);
    runInNewContext(readFileSync(controllerFile, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : load(name) });
    const repo = { id: 'owned', root: repoRoot };
    let duringResolve: () => void = () => undefined;
    const registry = { onDidChange: subscribe('repository'), list: () => closedRepo ? [] : [repo],
      resolveFile: async () => { reads++; duringResolve(); return repo; } };
    const policy = new PathPolicy(() => [repoRoot], () => trusted);
    const Provider = exports.HistoryCodeLens as new(registry: unknown, policy: unknown) => { provideCodeLenses(document: unknown, token: unknown): Promise<CodeLens[]>; dispose(): void };
    const provider = new Provider(registry, policy), token = { get isCancellationRequested() { return cancelled; } };
    assert.equal((await provider.provideCodeLenses(document, token)).length, 0); assert.equal(reads, 0);
    enabled = true;
    const lenses = await provider.provideCodeLenses(document, token); assert.equal(lenses.length, 1);
    assert.equal(lenses[0]!.command.command, 'gitPro.fileHistory'); assert.equal(lenses[0]!.command.arguments.length, 1); assert.equal(lenses[0]!.command.arguments[0], document.uri);
    for (const change of [() => { cancelled = true; }, () => { trusted = false; }, () => { enabled = false; }, () => { document.version++; }, () => { document.isDirty = true; }, () => { closedRepo = true; }, () => { events.get('repository')!(); }]) {
      cancelled = false; trusted = true; enabled = true; document.isDirty = false; closedRepo = false;
      duringResolve = change;
      assert.equal((await provider.provideCodeLenses(document, token)).length, 0);
    }
    cancelled = false; trusted = true; document.isDirty = false; closedRepo = false; duringResolve = () => undefined;
    document.uri.scheme = 'untitled'; assert.equal((await provider.provideCodeLenses(document, token)).length, 0); document.uri.scheme = 'file';
    document.uri.fsPath = outside; assert.equal((await provider.provideCodeLenses(document, token)).length, 0); document.uri.fsPath = file;
    document.isClosed = true; assert.equal((await provider.provideCodeLenses(document, token)).length, 0); document.isClosed = false;
    provider.dispose(); assert.equal(events.size, 0); assert.equal((await provider.provideCodeLenses(document, token)).length, 0);
  } finally { assert.ok(containsPath(await realpath(tmpdir()), root) && path.basename(root).startsWith('git-pro-codelens-unit-')); await rm(root, { recursive: true, force: true }); }
});
