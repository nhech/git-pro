import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { MenuRouter } from '../../src/webviews/menu-context';
import { toolContextValue, toolMenus } from '../../src/views/tools/tool-menus';

const oid = (digit: string) => digit.repeat(40);
const session = '3f2a9c1e-0000-4000-8000-123456789abc';

/** The compiled registerMenus against a stand-in vscode: `command` records every registration so a test can run any of them. */
function harness() {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>(), executed: unknown[][] = [], clipboard: string[] = [], selected: string[] = [], calls: unknown[][] = [], opened: unknown[][] = [];
  const vscode = { env: { clipboard: { writeText: async (value: string) => { clipboard.push(value); } } }, commands: { executeCommand: async (...args: unknown[]) => { executed.push(args); } }, Uri: { file: (fsPath: string) => ({ fsPath }) } };
  const source = path.resolve(__dirname, '../../src/commands/menu.commands.js'), load = createRequire(source), exports: Record<string, unknown> = {};
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : load(name) });
  const menus = new MenuRouter(), repositories = [{ id: 'repo-1', root: '/work/repo' }];
  const view = { tool: undefined as unknown };
  const record = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); };
  const compare = { openRefs: async (...args: unknown[]) => { opened.push(['refs', ...args]); }, openWorktree: async (...args: unknown[]) => { opened.push(['worktree', ...args]); } };
  const deps = { surfaces: { menus, compare }, registry: { list: () => repositories, select: (id: string) => { selected.push(id); } }, history: { message: async () => 'Subject\n\nBody' } };
  const flows = { advanced: { applyCommit: record('applyCommit'), rebasePlan: record('rebasePlan') }, tools: { checkoutCommit: record('checkoutCommit'), branchFromCommit: record('branchFromCommit'), tagAtCommit: record('tagAtCommit'), menu: record('toolsMenu') }, selectedTool: () => view.tool };
  (exports.registerMenus as (...args: unknown[]) => void)({}, deps, (id: string, action: (...args: unknown[]) => Promise<unknown>) => { handlers.set(id, action); }, flows);
  return { handlers, executed, clipboard, selected, calls, opened, menus, view, run: (id: string, ...args: unknown[]) => handlers.get(id)!(...args) };
}

test('every menu command the manifest contributes for the panels and views is registered, and nothing else', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { contributes: { commands: { command: string }[] } };
  const contributed = manifest.contributes.commands.map(item => item.command).filter(command => /^gitPro\.(?:menu|tools|repository)\.|^gitPro\.(?:stage|unstage)Group$|^gitPro\.changes\.viewAs/.test(command)).sort();
  assert.deepEqual([...harness().handlers.keys()].sort(), contributed);
  assert.deepEqual(toolMenus.map(([name]) => `gitPro.tools.${name}`).sort(), contributed.filter(command => command.startsWith('gitPro.tools.')), 'the table of Repository Tools choices is the manifest');
});

test('Repository Tools rows and groups carry the viewItem their menu entries are scoped to', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { contributes: { menus: Record<string, { command: string; when: string }[]> } };
  const entries = manifest.contributes.menus['view/item/context']!.filter(item => item.command.startsWith('gitPro.tools.'));
  assert.equal(entries.length, toolMenus.length);
  const values = { Stashes: ['stash', 'stashes'], Tags: ['tag', 'tags'], Remotes: ['remote', 'remotes'], Worktrees: ['worktree', 'worktrees'] } as const;
  for (const [group, [row, plural]] of Object.entries(values) as [keyof typeof values, readonly [string, string]][]) {
    assert.equal(toolContextValue(group, true), `gitPro.tools.row.${row}`); assert.equal(toolContextValue(group, false), `gitPro.tools.group.${plural}`);
    for (const item of entries.filter(entry => entry.command.startsWith(`gitPro.tools.${row}.`))) assert.ok(item.when.endsWith(`viewItem == ${toolContextValue(group, true)}`), item.command);
    for (const item of entries.filter(entry => entry.command.startsWith(`gitPro.tools.${plural}.`))) assert.ok(item.when.endsWith(`viewItem == ${toolContextValue(group, false)}`), item.command);
  }
});

test('Repository Tools menu commands pass the clicked node and the Quick Pick entry they stand for', async () => {
  const h = harness(), node = { kind: 'row', group: 'Stashes', repositoryId: 'repo-1', key: 'k' };
  await h.run('gitPro.tools.stash.pop', node); await h.run('gitPro.tools.worktrees.prune', { kind: 'group', group: 'Worktrees', repositoryId: 'repo-1' });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [['toolsMenu', node, 'Pop'], ['toolsMenu', { kind: 'group', group: 'Worktrees', repositoryId: 'repo-1' }, 'Prune']]);
});

test('Repositories menu selects the clicked repository first and then runs the command the toolbar runs', async () => {
  const h = harness(), repo = { id: 'repo-1', root: '/work/repo' };
  for (const [name, target] of [['history', 'gitPro.history'], ['fetch', 'gitPro.fetch'], ['pull', 'gitPro.pull'], ['push', 'gitPro.push'], ['tools', 'gitPro.repositoryTools']]) {
    h.selected.length = 0; h.executed.length = 0; await h.run(`gitPro.repository.${name}`, repo);
    assert.deepEqual(h.selected, ['repo-1']); assert.deepEqual(h.executed, [[target]]);
  }
  await h.run('gitPro.repository.copyPath', repo); assert.deepEqual(h.clipboard, ['/work/repo']);
  h.executed.length = 0; await h.run('gitPro.repository.reveal', repo); assert.deepEqual(JSON.parse(JSON.stringify(h.executed)), [['revealFileInOS', { fsPath: '/work/repo' }]]);
  for (const bad of [undefined, 'repo-1', { id: 'gone' }, { id: 7 }]) await assert.rejects(h.run('gitPro.repository.fetch', bad), /Select a repository/);
});

test('commit menu commands act on the commit a live panel confirms, through the reviewed flows', async () => {
  const h = harness(), shown = new Set([oid('a')]);
  h.menus.register('gitPro.history', session, { repositoryId: 'repo-1', knowsCommit: value => shown.has(value) });
  const argument = (extra: Record<string, unknown> = {}) => ({ webview: 'gitPro.history', webviewSection: 'commit', preventDefaultContextMenuItems: true, session, oid: oid('A'), ...extra });
  await h.run('gitPro.menu.commit.checkoutDetached', argument()); await h.run('gitPro.menu.commit.createBranch', argument()); await h.run('gitPro.menu.commit.createTag', argument());
  await h.run('gitPro.menu.commit.cherryPick', argument()); await h.run('gitPro.menu.commit.revert', argument()); await h.run('gitPro.menu.commit.rebaseFromHere', argument());
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [['checkoutCommit', 'repo-1', oid('a')], ['branchFromCommit', 'repo-1', oid('a')], ['tagAtCommit', 'repo-1', oid('a')],
    ['applyCommit', 'repo-1', 'cherryPick', oid('a')], ['applyCommit', 'repo-1', 'revert', oid('a')], ['rebasePlan', { repositoryId: 'repo-1', base: `${oid('a')}~1` }]], 'a full commit ID is lower-cased and named by the panel\'s repository');
  await h.run('gitPro.menu.commit.compareWithCurrent', argument()); await h.run('gitPro.menu.commit.compareWithWorkingTree', argument());
  assert.deepEqual(h.opened, [['refs', 'repo-1', oid('a'), 'HEAD'], ['worktree', 'repo-1', oid('a')]]);
  await h.run('gitPro.menu.commit.copyHash', argument()); await h.run('gitPro.menu.commit.copyMessage', argument()); assert.deepEqual(h.clipboard, [oid('a'), 'Subject\n\nBody']);
  const before = h.calls.length;
  await assert.rejects(h.run('gitPro.menu.commit.cherryPick', argument({ oid: oid('b') })), /no longer shown/, 'a commit the panel never showed');
  await assert.rejects(h.run('gitPro.menu.commit.cherryPick', argument({ webview: 'gitPro.conflicts' })), /Git Pro panel menu/, 'a panel without commits');
  await assert.rejects(h.run('gitPro.menu.commit.cherryPick', argument({ session: '00000000-0000-4000-8000-000000000000' })), /closed/);
  await assert.rejects(h.run('gitPro.menu.commit.cherryPick', undefined), /Git Pro panel menu/);
  assert.equal(h.calls.length, before, 'none of them reached a flow');
});

test('panel menu commands need the section of the element they are for and a live panel that handles them', async () => {
  const h = harness(), handled: string[][] = [];
  h.menus.register('gitPro.compare', session, { repositoryId: 'repo-1', handle: (action, context) => { handled.push([action, context!.section]); } });
  const argument = (section: string) => ({ webview: 'gitPro.compare', webviewSection: section, preventDefaultContextMenuItems: true, session, revision: 1, index: 0 });
  await h.run('gitPro.menu.compare.diff', argument('file')); await h.run('gitPro.menu.compare.showFiles', { ...argument('commit'), oid: oid('a') });
  assert.deepEqual(handled, [['diff', 'file'], ['showFiles', 'commit']]);
  await assert.rejects(h.run('gitPro.menu.compare.diff', argument('commit')), /Git Pro panel menu/, 'a file command on a commit row');
  await assert.rejects(h.run('gitPro.menu.conflicts.merge', argument('conflict')), /Git Pro panel menu/, 'a command of another panel');
});

test('a keyboard shortcut runs a Conflicts or planner command on the active tab\'s own selection, and nothing else', async () => {
  const h = harness(), handled: [string, string][] = [];
  let first = true;
  h.menus.register('gitPro.conflicts', session, { repositoryId: 'repo-1', active: () => first, handle: (action, context) => { handled.push([action, context === undefined ? 'keyboard' : context.section]); } });
  h.menus.register('gitPro.rebasePlanner', '11111111-0000-4000-8000-000000000000', { active: () => true, handle: (action, context) => { handled.push([`planner:${action}`, context === undefined ? 'keyboard' : context.section]); } });
  await h.run('gitPro.menu.conflicts.acceptYours'); await h.run('gitPro.menu.rebasePlanner.moveUp');
  assert.deepEqual(handled, [['acceptYours', 'keyboard'], ['planner:moveUp', 'keyboard']]);
  first = false; await assert.rejects(h.run('gitPro.menu.conflicts.merge'), /active editor/, 'a tab that is not the active editor is not what the shortcut means');
  first = true; h.menus.register('gitPro.conflicts', '22222222-0000-4000-8000-000000000000', { repositoryId: 'repo-2', active: () => true, handle: () => undefined });
  await assert.rejects(h.run('gitPro.menu.conflicts.merge'), /active editor/, 'two active tabs are ambiguous');
  // Panels whose rows are commits or files have no shortcut: those commands still need the row a menu was opened on.
  h.menus.register('gitPro.compare', '33333333-0000-4000-8000-000000000000', { repositoryId: 'repo-1', active: () => true, handle: () => undefined });
  await assert.rejects(h.run('gitPro.menu.compare.diff'), /Git Pro panel menu/); await assert.rejects(h.run('gitPro.menu.commit.copyHash'), /Git Pro panel menu/);
});

test('a shortcut in the Repository Tools view acts on the selected item, and an item named by a click wins', async () => {
  const h = harness(), clicked = { kind: 'row', group: 'Stashes', repositoryId: 'repo-1', key: 'a' }, selected = { kind: 'row', group: 'Tags', repositoryId: 'repo-1', key: 'v1' };
  h.view.tool = selected; await h.run('gitPro.tools.tag.deleteLocal'); await h.run('gitPro.tools.stash.drop', clicked);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [['toolsMenu', selected, 'Delete Local'], ['toolsMenu', clicked, 'Drop']]);
});
