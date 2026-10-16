import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { changeQuery, changeScheme, decorationFor, readChangeQuery } from '../../src/views/changes/change-decorations';
import { loadWithVscode } from './compare-loader';

/** Compiled module loaded against a stand-in `vscode`; any other import is the real compiled module. */
function load(file: string, vscode: unknown): Record<string, unknown> {
  const source = path.resolve(__dirname, '../../src/views/changes', file), requireFrom = createRequire(source), exports: Record<string, unknown> = {};
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : requireFrom(name) });
  return exports;
}
const disposable = { dispose: () => undefined };

test('a change draws a letter and a colour from its status, and its words go in the tooltip', () => {
  const rows: [string, string, string, string, string][] = [
    ['working', 'M', 'M', 'gitDecoration.modifiedResourceForeground', 'Modified'], ['staged', 'M', 'M', 'gitDecoration.stageModifiedResourceForeground', 'Modified'],
    ['staged', 'A', 'A', 'gitDecoration.addedResourceForeground', 'Added'], ['working', 'D', 'D', 'gitDecoration.deletedResourceForeground', 'Deleted'],
    ['staged', 'D', 'D', 'gitDecoration.stageDeletedResourceForeground', 'Deleted'], ['staged', 'R', 'R', 'gitDecoration.renamedResourceForeground', 'Renamed'],
    ['staged', 'C', 'C', 'gitDecoration.addedResourceForeground', 'Copied'], ['working', 'T', 'T', 'gitDecoration.modifiedResourceForeground', 'Type changed'],
    ['untracked', '?', 'U', 'gitDecoration.untrackedResourceForeground', 'Untracked'], ['conflicts', 'UU', '!', 'gitDecoration.conflictingResourceForeground', 'Both modified'],
    ['conflicts', 'DU', '!', 'gitDecoration.conflictingResourceForeground', 'Conflict']];
  for (const [group, status, badge, color, label] of rows) assert.deepEqual({ ...decorationFor(group, status) }, { badge, color, label }, `${group} ${status}`);
  assert.equal(decorationFor('staged', ' M').badge, 'M', 'a padded two-column status still gives its one letter'); assert.equal(decorationFor('working', '').badge, 'M');
  // The row's URI carries everything the decoration needs, so a decoration is never stale; odd statuses survive the round trip.
  for (const status of ['M', 'UU', '?', ' M', 'R100', 'a&b=c']) assert.deepEqual({ ...readChangeQuery(changeQuery({ group: 'working', status })) }, { group: 'working', status });
  assert.equal(readChangeQuery('g=working'), undefined); assert.equal(readChangeQuery(''), undefined); assert.equal(changeScheme, 'git-pro-change');
});

test('the decoration provider answers for its own scheme only and builds a themed badge', () => {
  class ThemeColor { constructor(readonly id: string) {} }
  class EventEmitter { event = () => disposable; fire(): void { /* nothing listens in this test */ } dispose(): void { /* nothing to release */ } }
  let registered: unknown; let disposed = 0;
  const vscode = { ThemeColor, EventEmitter, window: { registerFileDecorationProvider: (provider: unknown) => { registered = provider; return { dispose: () => { disposed++; } }; } } };
  const module = load('change-decoration-provider.js', vscode);
  const provider = new (module.ChangeDecorationProvider as new () => { provideFileDecoration(uri: unknown): { badge: string; color: { id: string }; tooltip: string; propagate: boolean } | undefined; dispose(): void })();
  assert.equal(registered, provider);
  const uri = (scheme: string, query: string) => ({ scheme, query });
  const decoration = provider.provideFileDecoration(uri(changeScheme, changeQuery({ group: 'staged', status: 'M' })))!;
  assert.deepEqual({ badge: decoration.badge, color: decoration.color.id, tooltip: decoration.tooltip, propagate: decoration.propagate }, { badge: 'M', color: 'gitDecoration.stageModifiedResourceForeground', tooltip: 'Modified', propagate: false });
  assert.equal(provider.provideFileDecoration(uri('file', changeQuery({ group: 'staged', status: 'M' }))), undefined, 'a file of the workspace is not ours to decorate');
  assert.equal(provider.provideFileDecoration(uri(changeScheme, 'nothing=here')), undefined);
  provider.dispose(); assert.equal(disposed, 1);
});

test('the Changes view is a native multi-select tree with a badge, a repository name only when there are several, and a key for its grouping', async () => {
  const executed: unknown[][] = [], created: { id: string; options: Record<string, unknown> }[] = [];
  const view = { selection: ['row'], visible: true, badge: undefined as unknown, description: undefined as unknown, dispose: () => { disposed++; } };
  let disposed = 0, mode = 'status';
  const vscode = { Uri: { file: (root: string) => ({ fsPath: root }) }, commands: { executeCommand: async (...args: unknown[]) => { executed.push(args); } },
    window: { createTreeView: (id: string, options: Record<string, unknown>) => { created.push({ id, options }); return view; } },
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: string) => mode || fallback }), onDidChangeConfiguration: () => disposable } };
  const module = load('changes-view.js', vscode);
  const repos = [{ id: 'one', root: path.join(path.sep, 'work', 'one') }];
  let snapshot: { changes: unknown[]; omitted?: unknown[] } | undefined = { changes: [{}, {}], omitted: [{}] }; let fire: () => void = () => undefined;
  const registry = { active: repos[0] as { id: string; root: string } | undefined, list: () => repos, errors: new Map<string, string>(), store: { get: () => snapshot }, onDidChange: (listener: () => void) => { fire = listener; return disposable; } };
  const instance = new (module.ChangesView as new (registry: unknown, provider: unknown) => { selection: unknown[]; isResolved: boolean; dispose(): void })(registry, { marker: 'provider' });
  assert.equal(created[0]!.id, 'gitPro.changes'); assert.deepEqual({ ...created[0]!.options, treeDataProvider: 'provider' }, { treeDataProvider: 'provider', canSelectMany: true, showCollapseAll: true });
  assert.deepEqual({ ...(view.badge as object) }, { value: 3, tooltip: '3 changes' }, 'omitted entries count too'); assert.equal(view.description, '', 'one repository: its name is not repeated');
  assert.deepEqual(executed.at(-1), ['setContext', 'gitPro.changes.groupBy', 'status']);
  assert.deepEqual(Array.from(instance.selection), ['row']); assert.equal(instance.isResolved, true); view.visible = false; assert.equal(instance.isResolved, false);
  snapshot = { changes: [{}] }; repos.push({ id: 'two', root: path.join(path.sep, 'work', 'two') }); mode = 'folder'; fire();
  assert.deepEqual({ ...(view.badge as object) }, { value: 1, tooltip: '1 change' }); assert.equal(view.description, 'one', 'several repositories: the view says which one it shows');
  assert.deepEqual(executed.at(-1), ['setContext', 'gitPro.changes.groupBy', 'folder']);
  registry.errors.set('one', 'status failed'); fire(); assert.equal(view.badge, undefined, 'a failed read shows no count'); registry.errors.clear();
  snapshot = { changes: [] }; fire(); assert.equal(view.badge, undefined, 'nothing changed: no badge');
  registry.active = undefined; fire(); assert.equal(view.description, ''); instance.dispose(); assert.equal(disposed, 1);
});

test('the Conflicts group and the operation row open the whole Conflicts tab; a file row and other groups do not', () => {
  class Uri { constructor(readonly fsPath: string) {} }
  const module = loadWithVscode(path.resolve(__dirname, '../../src/commands/conflicts.commands.js'), { Uri, window: {}, workspace: {}, commands: {}, EventEmitter: class {}, Disposable: class {} });
  const whole = module.wholeTabRepository as (value: unknown) => string | undefined;
  assert.equal(whole({ kind: 'operation', repositoryId: 'repo-1', banner: {} }), 'repo-1'); assert.equal(whole({ kind: 'group', repositoryId: 'repo-1', group: 'conflicts' }), 'repo-1');
  for (const other of [{ kind: 'group', repositoryId: 'repo-1', group: 'working' }, { kind: 'file', repositoryId: 'repo-1', change: { path: 'a.ts', group: 'conflicts' } }, { kind: 'operation' }, { kind: 'group', group: 'conflicts' }, undefined, 'repo-1', null, 7]) assert.equal(whole(other), undefined);
});
