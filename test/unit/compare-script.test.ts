import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

type Listener = (event: Record<string, unknown>) => void;
class Element {
  static active: Element | undefined;
  children: Element[] = []; parent: Element | undefined; text = ''; className = ''; id = ''; hidden = false; disabled = false; tabIndex = -1; title = ''; type = ''; isConnected = true;
  dataset: Record<string, string> = {}; style: Record<string, string> = {}; attributes = new Map<string, string>(); listeners = new Map<string, Listener>();
  constructor(readonly tag = 'div') {}
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.text = String(value); }
  append(...nodes: Element[]) { for (const node of nodes) { node.parent?.children.splice(node.parent.children.indexOf(node), 1); node.parent = this; node.isConnected = true; this.children.push(node); } }
  replaceChildren(...nodes: Element[]) { const detach = (node: Element) => { node.isConnected = false; node.children.forEach(detach); }; this.children.forEach(detach); this.children = []; this.text = ''; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined; this.isConnected = false; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); } getAttribute(key: string) { return this.attributes.get(key); }
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, listener); }
  focus() { Element.active = this; this.listeners.get('focus')?.({ target: this }); }
  contains(node: Element): boolean { return node === this || this.children.some(child => child.contains(node)); }
  getBoundingClientRect() { return { left: 10, top: 10, width: 100, height: 40 }; }
  fire(type: string, event: Record<string, unknown> = {}) { const listener = this.listeners.get(type); assert.ok(listener, `${this.className || this.tag} handles ${type}`); listener({ preventDefault: () => undefined, stopPropagation: () => undefined, ...event }); }
  all(): Element[] { return this.children.flatMap(child => [child, ...child.all()]); }
  find(predicate: (node: Element) => boolean): Element | undefined { return this.all().find(predicate); }
  key(value: string) { this.fire('keydown', { key: value }); }
}
const ids = ['title', 'summary', 'moved', 'moved-text', 'moved-refresh', 'status', 'workspace', 'commits', 'files', 'files-mode', 'layout', 'files-heading', 'legend', 'file-rows', 'files-empty', 'files-pager', 'files-footer', 'worktree-actions', 'get-from-branch', 'selection-hint', 'swap', 'refresh', 'open-all', 'files-filter', 'filter-text', 'filter-status'];
const oid = (value: number) => value.toString(16).padStart(40, '0');
const commit = (value: number, subject = `Commit ${value}`) => ({ oid: oid(value), subject, author: 'Fixture', timestamp: 1700000000, refs: [] as string[] });

/** Timers the script under test starts (the filter's pause), run by hand. */
const timers: (() => void)[] = [];
const context = (element: Element) => JSON.parse(element.getAttribute('data-vscode-context') ?? 'null') as Record<string, unknown>;

function harness(saved?: unknown) {
  Element.active = undefined;
  const elements = new Map(ids.map(id => { const element = new Element(['moved-refresh', 'get-from-branch', 'swap', 'refresh', 'open-all', 'layout'].includes(id) ? 'button' : 'div'); element.id = id; return [id, element]; }));
  const body = new Element('body'); body.dataset.session = 'session-1';
  const sent: Record<string, unknown>[] = [], created: string[] = [], states: unknown[] = [], windowListeners = new Map<string, Listener>();
  const document = { body, get activeElement() { return Element.active ?? body; }, hasFocus: () => true, getElementById: (id: string) => elements.get(id), createElement: (tag: string) => { created.push(tag); return new Element(tag); }, addEventListener: () => undefined };
  const window = { innerWidth: 800, innerHeight: 600, addEventListener: (type: string, listener: Listener) => windowListeners.set(type, listener) };
  // Values built in the VM realm are copied to plain objects so strict deep equality compares content, not realms.
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  runInNewContext(readFileSync('media/compare.js', 'utf8'), { document, window, setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; }, clearTimeout: () => undefined, acquireVsCodeApi: () => ({ postMessage: (value: Record<string, unknown>) => sent.push(copy(value)), getState: () => saved, setState: (value: unknown) => states.push(copy(value)) }) });
  const post = (data: Record<string, unknown>) => windowListeners.get('message')!({ data: { session: 'session-1', ...data } });
  const get = (id: string) => elements.get(id)!;
  return { elements, get, body, sent, created, states, post, windowListeners };
}
const commitsState = (overrides: Record<string, unknown> = {}) => ({
  type: 'state', revision: 4, mode: 'commits', left: { name: 'feature', oid: oid(1), current: false }, right: { name: 'main', oid: oid(2), current: true }, swapped: false, head: 'main', filesMode: 'fork', moved: [], loading: false,
  fork: { oid: oid(3), multiple: false },
  sides: { leftOnly: { count: 30, offset: 0, commits: [commit(10, '<img src=x onerror=alert(1)>'), ...Array.from({ length: 24 }, (_, index) => commit(index + 11))] }, rightOnly: { count: 0, offset: 0, commits: [] } },
  files: { scope: 'fork', from: oid(3), to: oid(1), total: 3, offset: 0, omitted: false, binary: 1, items: [
    { index: 0, status: 'M', path: 'src/app.ts', added: 3, removed: 1, binary: false }, { index: 1, status: 'A', path: 'logo.png', added: null, removed: null, binary: true }, { index: 2, status: 'R', path: 'src/new.ts', originalPath: 'src/old.ts', added: 0, removed: 0, binary: false }] },
  ...overrides
});

test('Compare renders the WebStorm header, directional lists and empty text as text, and acts by loaded OID and revision', () => {
  const h = harness();
  assert.deepEqual(h.sent[0], { type: 'ready', session: 'session-1' });
  h.post(commitsState());
  const title = h.get('title');
  assert.equal(title.textContent, 'Compare feature with ●main(current)');
  const chips = title.children.filter(child => child.className.startsWith('ref'));
  assert.deepEqual(chips.map(chip => chip.className), ['ref', 'ref current'], 'Only the checked-out branch carries the accent marker');
  assert.equal(h.get('summary').textContent, `Fork point ${oid(3).slice(0, 8)} · feature +30 · main +0`);
  const [left, right] = h.get('commits').children;
  assert.equal(left!.getAttribute('aria-label'), 'Commits in feature, not in main'); assert.equal(right!.getAttribute('aria-label'), 'Commits in main, not in feature');
  assert.equal(right!.find(node => node.className === 'empty')?.textContent, 'Every commit of main is already in feature');
  const rows = left!.find(node => node.className === 'commit-rows')!.children;
  assert.equal(rows.length, 25); assert.equal(rows[0]!.find(node => node.className === 'subject-text')?.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(h.created.includes('img') || h.created.includes('script'), false, 'Repository text never becomes markup');
  assert.equal(rows[0]!.tabIndex, 0); assert.equal(rows[1]!.tabIndex, -1, 'Each list is one tab stop with a roving tabindex');
  rows[1]!.fire('click'); assert.deepEqual(h.sent.at(-1), { type: 'selectCommit', revision: 4, oid: oid(11), session: 'session-1' });
  rows[1]!.key('ArrowDown'); assert.equal(Element.active, rows[2]); rows[2]!.key('Enter'); assert.equal(h.sent.at(-1)?.oid, oid(12));
  // Right-click is VS Code's own menu: each row names its commit and the revision it showed, and the row under the pointer takes focus first.
  assert.deepEqual(context(h.body), { preventDefaultContextMenuItems: true }, 'outside a row nothing offers Cut, Copy and Paste');
  assert.deepEqual(context(rows[2]!), { preventDefaultContextMenuItems: true, session: 'session-1', revision: 4, webviewSection: 'commit', oid: oid(12), commitShown: false });
  rows[0]!.fire('contextmenu'); assert.equal(Element.active, rows[0], 'a right-click moves focus to the row it opens the menu for'); assert.equal(h.body.children.length, 0, 'no menu of ours is drawn');
  rows[2]!.fire('keydown', { key: 'F10', shiftKey: true }); assert.equal(h.body.children.length, 0, 'the keyboard menu key is left to the browser, which asks for the native menu');
  const pager = left!.find(node => node.className === 'pager')!, [previous, next] = pager.children;
  assert.equal(previous!.disabled, true); next!.fire('click'); assert.deepEqual(h.sent.at(-1), { type: 'page', revision: 4, side: 'left', offset: 25, session: 'session-1' });
  assert.match(pager.textContent, /1–25 of 30/);
});

test('Compare files show a directory tree with status, stats and inline actions, a flat list on request and the files modes', () => {
  const h = harness();
  h.post(commitsState());
  const tree = h.get('file-rows'), rows = tree.children;
  assert.deepEqual(rows.map(row => row.getAttribute('role') === 'treeitem' ? row.dataset.focusKey : row.className), ['dir:src', 'file:0', 'file:2', 'file:1'], 'Directories first, then root files');
  const app = rows[1]!; assert.equal(app.dataset.status, 'M'); assert.equal(app.getAttribute('aria-level'), '2'); assert.equal(app.getAttribute('aria-label'), 'src/app.ts, Modified, 3 added, 1 removed');
  assert.equal(app.find(node => node.className === 'file-status')?.textContent, 'M');
  assert.equal(rows[2]!.find(node => node.className === 'file-origin')?.textContent, '← src/old.ts'); assert.equal(rows[3]!.find(node => node.className === 'file-stat')?.textContent, 'Binary');
  app.fire('click'); assert.deepEqual(h.sent.at(-1), { type: 'diff', revision: 4, index: 0, session: 'session-1' });
  app.find(node => node.dataset.inlineAction === 'localDiff')!.fire('click'); assert.deepEqual(h.sent.at(-1), { type: 'localDiff', revision: 4, index: 0, session: 'session-1' });
  assert.deepEqual(context(app), { preventDefaultContextMenuItems: true, session: 'session-1', revision: 4, webviewSection: 'file', index: 0, indexes: '0', compareWorktree: false, fileOnlyInBranch: false });
  assert.deepEqual(context(rows[2]!), { preventDefaultContextMenuItems: true, session: 'session-1', revision: 4, webviewSection: 'file', index: 2, indexes: '2', compareWorktree: false, fileOnlyInBranch: false });
  app.fire('contextmenu'); assert.equal(h.body.children.length, 0, 'no menu of ours is drawn');
  rows[0]!.focus(); rows[0]!.key('ArrowLeft'); assert.equal(tree.children.length, 2, 'Collapsing a directory hides its files'); assert.equal(Element.active?.dataset.focusKey, 'dir:src', 'Focus stays on the collapsed directory');
  tree.children[0]!.key('ArrowRight'); assert.equal(tree.children.length, 4); tree.children[0]!.key('ArrowDown'); assert.equal(Element.active?.dataset.focusKey, 'file:0'); Element.active!.key('ArrowLeft'); assert.equal(Element.active?.dataset.focusKey, 'dir:src');
  h.get('layout').fire('click'); assert.equal((h.states.at(-1) as { flat?: boolean }).flat, true);
  assert.deepEqual(tree.children.map(row => row.dataset.focusKey), ['file:0', 'file:1', 'file:2']); assert.equal(tree.children[0]!.find(node => node.className === 'file-dir')?.textContent, 'src');
  assert.equal(h.get('files-footer').textContent, '3 files · 1 binary not in All Changes');
  const modes = h.get('files-mode').children.filter(node => node.getAttribute('role') === 'radio');
  assert.deepEqual(modes.map(node => [node.textContent, node.getAttribute('aria-checked')]), [['Since fork', 'true'], ['Tip to tip', 'false']]);
  modes[1]!.fire('click'); assert.deepEqual(h.sent.at(-1), { type: 'filesMode', revision: 4, mode: 'tips', session: 'session-1' });
  h.get('open-all').fire('click'); assert.deepEqual(h.sent.at(-1), { type: 'openAll', revision: 4, session: 'session-1' });
  h.get('swap').fire('click'); assert.deepEqual(h.sent.at(-1), { type: 'swap', revision: 4, session: 'session-1' });
  h.post(commitsState({ revision: 5, files: { scope: 'commit', commit: { oid: oid(11), subject: 'Commit 11' }, from: oid(9), to: oid(11), total: 1, offset: 0, omitted: false, binary: 0, items: [{ index: 0, status: 'D', path: 'gone.txt', added: 0, removed: 2, binary: false }] } }));
  assert.equal(h.get('files-mode').hidden, true, 'Modes apply to the branch diff, not to one commit');
  assert.match(h.get('files-heading').textContent, /Files in 00000000 · Commit 11/);
  const selected = h.get('commits').children[0]!.find(node => node.getAttribute('aria-selected') === 'true'); assert.equal(selected?.dataset.focusKey, `commit:left:${oid(11)}`);
  h.get('files-heading').find(node => node.textContent === 'All changes')!.fire('click'); assert.deepEqual(h.sent.at(-1), { type: 'allChanges', revision: 5, session: 'session-1' });
  assert.equal(h.get('open-all').title, 'Open All Changes in 00000000');
});

test('Compare states: same commit, notes, empty and omitted files, moved refs, errors, busy and foreign sessions', () => {
  const h = harness({ flat: true });
  h.post(commitsState({ right: { name: 'main', oid: oid(1), current: true } })); assert.equal(h.get('summary').textContent, 'feature and main point to the same commit.');
  h.post(commitsState({ files: { scope: 'tips', from: oid(1), to: oid(2), total: 0, offset: 0, omitted: false, binary: 0, items: [], note: 'noCommonAncestor' }, fork: { oid: null, multiple: false } }));
  assert.match(h.get('summary').textContent, /^No common ancestor · /); assert.match(h.get('files-heading').textContent, /No common ancestor; showing tip-to-tip file changes\./);
  assert.equal(h.get('files-empty').textContent, 'No differences.'); assert.equal(h.get('open-all').disabled, true);
  assert.equal(h.get('file-rows').children.length, 0); assert.equal(h.get('file-rows').hidden, true, 'the empty state is beside the tree, never inside role=tree');
  h.post(commitsState({ files: { scope: 'fork', from: oid(3), to: oid(1), total: 0, offset: 0, omitted: true, binary: 0, items: [], note: 'multipleMergeBases' } }));
  assert.equal(h.get('files-empty').textContent, 'Too many changed files to list here.'); assert.equal(h.get('file-rows').children.length, 0); assert.match(h.get('files-heading').textContent, /Multiple merge bases; showing changes since 00000000\./);
  h.post(commitsState({ moved: ['main'] })); assert.equal(h.get('moved').hidden, false); assert.equal(h.get('moved-text').textContent, 'main has moved since this comparison.');
  h.get('moved-refresh').fire('click'); assert.deepEqual(h.sent.at(-1), { type: 'refresh', session: 'session-1' });
  h.post({ type: 'error', message: 'Comparison changed. Review again.' }); assert.equal(h.get('status').textContent, 'Comparison changed. Review again.'); assert.equal(h.get('status').className, 'error');
  h.post({ type: 'notice', message: 'Opened the first 300 of 305 text files.' }); assert.equal(h.get('status').className, '');
  h.post({ type: 'busy', busy: true }); const count = h.sent.length;
  h.get('file-rows').children[0]?.fire('click'); h.get('swap').fire('click'); h.get('refresh').fire('click');
  assert.equal(h.sent.length, count, 'Busy blocks every request'); assert.equal(h.get('swap').disabled, true); assert.equal(h.get('workspace').getAttribute('aria-busy'), 'true');
  h.post({ type: 'busy', busy: false, session: 'other' }); assert.equal(h.get('swap').disabled, true, 'A foreign session is ignored');
  h.post({ ...commitsState({ left: { name: 'hijacked', oid: oid(9), current: false } }), session: 'other' }); assert.doesNotMatch(h.get('title').textContent, /hijacked/);
  h.post({ type: 'busy', busy: false }); assert.equal(h.get('swap').disabled, false);
  h.post({ type: 'state', revision: 0, mode: 'commits', left: { name: 'feature', oid: oid(1), current: false }, right: { name: 'main', oid: oid(2), current: true }, loading: false, error: 'fatal: bad revision' });
  assert.equal(h.get('files-heading').textContent, 'fatal: bad revision'); assert.equal(h.get('open-all').disabled, true);
});

test('Compare explains withheld non-UTF-8 lists, shallow clones, vanished refs and a closed repository in words', () => {
  const h = harness({ flat: true });
  h.post(commitsState({ files: { scope: 'fork', from: oid(3), to: oid(1), total: 0, offset: 0, omitted: true, binary: 0, items: [], note: 'nonUtf8Path' } }));
  assert.equal(h.get('files-empty').textContent, 'Some changed paths are not valid UTF-8, so the file list is unavailable here; use a terminal for this comparison.');
  assert.equal(h.get('file-rows').hidden, true); assert.equal(h.get('open-all').disabled, true); assert.doesNotMatch(h.get('files-heading').textContent, /Too many/);
  h.post(commitsState({ fork: { oid: null, multiple: false, shallow: true }, files: { scope: 'tips', from: oid(1), to: oid(2), total: 1, offset: 0, omitted: false, binary: 0, note: 'shallowHistory', items: [{ index: 0, status: 'M', path: 'a.txt', added: 1, removed: 1, binary: false }] } }));
  assert.equal(h.get('summary').textContent, 'Fork point unknown (shallow clone) · feature +30 · main +0');
  assert.match(h.get('files-heading').textContent, /This repository is a shallow clone, so the common ancestor and the commit counts may be incomplete; showing tip-to-tip file changes\./);
  assert.doesNotMatch(h.get('files-heading').textContent, /No common ancestor/);
  h.post(commitsState({ gone: ['feature'] }));
  assert.equal(h.get('moved').hidden, false); assert.equal(h.get('moved-text').textContent, 'feature no longer resolves to a commit; the comparison keeps its pinned commits.');
  assert.equal(h.get('moved-refresh').hidden, true, 'Refresh could only fail while a ref is gone');
  h.post(commitsState({ moved: ['main'], gone: ['feature', 'topic'] }));
  assert.equal(h.get('moved-text').textContent, 'main has moved since this comparison. feature, topic no longer resolve to commits; the comparison keeps its pinned commits.');
  h.post(commitsState({ moved: ['main'] })); assert.equal(h.get('moved-refresh').hidden, false);
  h.post(commitsState({ expired: true, moved: [] }));
  assert.equal(h.get('moved').hidden, false); assert.equal(h.get('moved-text').textContent, 'This repository is no longer open in Git Pro, so this comparison cannot be refreshed. Open the repository again to continue.');
  assert.equal(h.get('moved-refresh').hidden, true);
  h.post(commitsState()); assert.equal(h.get('moved').hidden, true);
});

test('Working-tree mode shows the WebStorm header and colour legend, and Get from Branch acts on up to 100 selected indexes', () => {
  const h = harness({ flat: true });
  const state = { type: 'state', revision: 2, mode: 'worktree', left: { name: 'feature', oid: oid(1), current: false }, swapped: false, head: 'main', filesMode: 'fork', moved: [], loading: false,
    files: { scope: 'worktree', from: oid(1), total: 3, offset: 0, omitted: false, binary: 0, items: [
      { index: 0, status: 'M', path: 'src/app.ts', added: 1, removed: 1, binary: false, presence: 'both' }, { index: 1, status: 'D', path: 'only-branch.txt', added: 0, removed: 4, binary: false, presence: 'branch' }, { index: 2, status: 'A', path: 'local.txt', added: 2, removed: 0, binary: false, presence: 'worktree' }] } };
  h.post(state);
  assert.equal(h.get('title').textContent, 'Files in feature compared with the working tree on main');
  assert.equal(h.get('commits').hidden, true); assert.equal(h.get('workspace').className, 'files-only'); assert.equal(h.get('files-mode').hidden, true);
  assert.deepEqual(h.get('legend').children.map(chip => [chip.dataset.presence, chip.textContent]), [['branch', 'Only in feature'], ['worktree', 'Only in the working tree'], ['both', 'Changed in both']]);
  const rows = h.get('file-rows').children; assert.equal(h.get('file-rows').getAttribute('aria-multiselectable'), 'true');
  assert.deepEqual(rows.map(row => row.dataset.presence), ['both', 'branch', 'worktree']); assert.match(rows[1]!.getAttribute('aria-label')!, /Only in feature/, 'Colour is never the only signal');
  assert.equal(rows[1]!.find(node => node.dataset.inlineAction === 'openFile'), undefined, 'A file only in the branch cannot be opened locally');
  assert.equal(rows[0]!.find(node => node.dataset.inlineAction === 'localDiff'), undefined, 'The diff already is against the working tree');
  assert.equal(h.get('get-from-branch').disabled, true);
  rows[0]!.fire('click'); assert.deepEqual(h.sent.at(-1), { type: 'diff', revision: 2, index: 0, session: 'session-1' }); assert.equal(rows[0]!.getAttribute('aria-selected'), 'true');
  rows[1]!.fire('click', { ctrlKey: true }); assert.equal(h.sent.at(-1)?.type, 'diff', 'Ctrl-click only changes the selection');
  assert.equal(h.get('get-from-branch').textContent, 'Get 2 Files from feature'); assert.equal(h.get('get-from-branch').disabled, false);
  h.get('get-from-branch').fire('click'); assert.deepEqual(h.sent.at(-1), { type: 'getFromBranch', revision: 2, indexes: [0, 1], session: 'session-1' });
  rows[2]!.fire('click', { shiftKey: true }); assert.equal(h.get('selection-hint').textContent, '2 files selected', 'Shift-click selects the range from the anchor');
  assert.deepEqual(context(rows[2]!), { preventDefaultContextMenuItems: true, session: 'session-1', revision: 2, webviewSection: 'file', index: 2, indexes: '1,2', compareWorktree: true, fileOnlyInBranch: false }, 'a row of the selection names the whole selection');
  assert.equal(context(rows[1]!).fileOnlyInBranch, true, 'a file only in the branch has no local file to open'); assert.equal(context(rows[0]!).indexes, '0', 'a row outside the selection names only itself');
  const before = h.sent.length; rows[2]!.fire('contextmenu'); assert.equal(h.sent.length, before, 'a right-click opens no diff'); assert.equal(h.get('selection-hint').textContent, '2 files selected', 'a right-click inside the selection keeps it');
  rows[0]!.fire('contextmenu'); assert.equal(h.get('selection-hint').textContent, '1 file selected', 'as in the Explorer, a right-click outside the selection selects just that row');
  assert.equal(context(rows[0]!).indexes, '0'); assert.equal(context(rows[1]!).indexes, '1'); assert.equal(context(rows[2]!).indexes, '2');
  rows[1]!.focus(); rows[1]!.key(' '); assert.equal(rows[1]!.getAttribute('aria-selected'), 'true', 'Space toggles a row into the selection'); assert.equal(context(rows[0]!).indexes, '0,1', 'and the menu names it too');
  rows[1]!.focus(); const selectAll = { prevented: false }; rows[1]!.fire('keydown', { key: 'a', ctrlKey: true, preventDefault: () => { selectAll.prevented = true; } });
  assert.equal(selectAll.prevented, true); assert.equal(h.get('selection-hint').textContent, '3 files selected', 'Ctrl+A selects every file of the list'); assert.deepEqual(rows.map(row => row.getAttribute('aria-selected')), ['true', 'true', 'true']);
  assert.equal(context(rows[2]!).indexes, '0,1,2', 'and every row names the whole selection for the menu');
  h.post({ ...state, revision: 3 }); assert.equal(h.get('get-from-branch').disabled, true, 'A new revision clears the selection: its indexes belong to the old list');
  h.post({ ...state, revision: 3, swapped: true }); assert.equal(h.get('title').textContent, 'The working tree on main compared with files in feature');
  h.post({ ...state, revision: 4, files: { ...state.files, total: 0, items: [] } }); assert.equal(h.get('files-empty').textContent, 'No differences between feature and the working tree.');
  assert.equal(h.get('file-rows').hidden, true);
  h.post({ ...state, revision: 5 }); assert.equal(h.get('file-rows').hidden, false); assert.equal(h.get('files-empty').hidden, true);
});

test('a diff opened over the tab keeps the Get from Branch selection and the focused row when the renderer comes back with the same list', () => {
  const state = { type: 'state', revision: 2, mode: 'worktree', left: { name: 'feature', oid: oid(1), current: false }, swapped: false, head: 'main', filesMode: 'fork', moved: [], loading: false,
    files: { scope: 'worktree', from: oid(1), total: 3, offset: 0, omitted: false, binary: 0, items: [
      { index: 0, status: 'M', path: 'a.ts', added: 1, removed: 1, binary: false, presence: 'both' }, { index: 1, status: 'M', path: 'b.ts', added: 1, removed: 1, binary: false, presence: 'both' }, { index: 2, status: 'M', path: 'c.ts', added: 1, removed: 1, binary: false, presence: 'both' }] } };
  const before = harness({ flat: true });
  before.post(state); const rows = before.get('file-rows').children;
  rows[0]!.fire('click'); rows[1]!.fire('click', { ctrlKey: true }); rows[1]!.focus();
  assert.deepEqual(before.sent.at(-1), { type: 'diff', revision: 2, index: 0, session: 'session-1' }, 'a plain click opens the diff, which hides this tab');
  const saved = before.states.at(-1) as Record<string, unknown>;
  assert.deepEqual(saved, { flat: true, session: 'session-1', revision: 2, chosen: [0, 1], anchor: 1, focusKey: 'file:1' });
  // VS Code recreates the renderer (retainContextWhenHidden: false) and the host replays the same revision.
  const after = harness(saved); after.post(state);
  assert.equal(after.get('get-from-branch').textContent, 'Get 2 Files from feature'); assert.equal(after.get('get-from-branch').disabled, false);
  assert.deepEqual(after.get('file-rows').children.map(row => row.getAttribute('aria-selected')), ['true', 'true', 'false']);
  assert.equal(Element.active?.dataset.focusKey, 'file:1', 'focus returns to the row');
  after.get('file-rows').children[2]!.fire('click', { shiftKey: true }); assert.equal(after.get('selection-hint').textContent, '2 files selected', 'the anchor came back too: Shift-click ranges from b.ts');
  const changed = harness(saved); changed.post({ ...state, revision: 3 });
  assert.equal(changed.get('get-from-branch').disabled, true, 'another revision is another list: its indexes do not carry over');
  const foreign = harness({ ...saved, session: 'session-0' }); foreign.post(state);
  assert.equal(foreign.get('get-from-branch').disabled, true, 'state from another panel session is ignored');
});

test('The file filter sends a trimmed name fragment after a pause and the change types at once, shows the host\'s answer and never fights the typing', () => {
  timers.length = 0;
  {
    const h = harness({ flat: true }), input = h.get('filter-text'), chips = h.get('filter-status').children;
    assert.equal(h.get('files-filter').hidden, true, 'nothing to filter before the files arrive');
    h.post(commitsState()); assert.equal(h.get('files-filter').hidden, false);
    assert.deepEqual(chips.map(chip => [chip.textContent, chip.getAttribute('aria-label'), chip.getAttribute('aria-pressed')]), [['A', 'Added files', 'false'], ['M', 'Modified files', 'false'], ['D', 'Deleted files', 'false'], ['R', 'Renamed files', 'false']]);
    (input as unknown as { value: string }).value = '  app '; input.fire('input'); input.fire('input'); assert.equal(h.sent.filter(m => m.type === 'filter').length, 0, 'typing waits for a pause');
    timers.at(-1)!(); assert.deepEqual(h.sent.at(-1), { type: 'filter', revision: 4, text: 'app', statuses: '', session: 'session-1' });
    chips[1]!.fire('click'); assert.deepEqual(h.sent.at(-1), { type: 'filter', revision: 4, text: 'app', statuses: 'M', session: 'session-1' }, 'a change type applies at once, with the text');
    // The host answers with the files that match: the heading says how many of how many.
    h.post(commitsState({ revision: 5, filter: { text: 'app', statuses: 'M' }, files: { scope: 'fork', from: oid(3), to: oid(1), total: 1, unfiltered: 3, offset: 0, omitted: false, binary: 0, items: [{ index: 0, status: 'M', path: 'src/app.ts', added: 3, removed: 1, binary: false }] } }));
    assert.match(h.get('files-heading').textContent, /Changes in feature since the fork point · 1 of 3/); assert.equal(chips[1]!.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(h.get('file-rows').children.map(row => row.dataset.focusKey), ['file:0'], 'the row keeps the index it has in the captured list');
    // Typing in progress is not overwritten by an answer to an earlier request.
    Element.active = input; (input as unknown as { value: string }).value = 'app.t'; h.post(commitsState({ revision: 6, filter: { text: 'app', statuses: 'M' }, files: { scope: 'fork', from: oid(3), to: oid(1), total: 1, unfiltered: 3, offset: 0, omitted: false, binary: 0, items: [{ index: 0, status: 'M', path: 'src/app.ts', added: 3, removed: 1, binary: false }] } }));
    assert.equal((input as unknown as { value: string }).value, 'app.t');
    // Busy blocks a request, which goes out when the tab is free again.
    h.post({ type: 'busy', busy: true }); const before = h.sent.length; timers.length = 0; input.fire('input'); timers.at(-1)!(); assert.equal(h.sent.length, before);
    h.post({ type: 'busy', busy: false }); assert.deepEqual(h.sent.at(-1), { type: 'filter', revision: 6, text: 'app.t', statuses: 'M', session: 'session-1' });
    // Escape clears the text.
    Element.active = input; const escape = { prevented: false }; input.fire('keydown', { key: 'Escape', preventDefault: () => { escape.prevented = true; } });
    assert.equal(escape.prevented, true); assert.equal((input as unknown as { value: string }).value, ''); assert.equal(h.sent.at(-1)?.text, '');
    // A filter that matches nothing says so beside the (kept) filter row.
    h.post(commitsState({ revision: 7, filter: { text: 'zzz', statuses: '' }, files: { scope: 'fork', from: oid(3), to: oid(1), total: 0, unfiltered: 3, offset: 0, omitted: false, binary: 0, items: [] } }));
    assert.equal(h.get('files-empty').textContent, 'No files match the filter.'); assert.equal(h.get('files-filter').hidden, false);
    h.post(commitsState({ revision: 8, files: { scope: 'fork', from: oid(3), to: oid(1), total: 0, offset: 0, omitted: false, binary: 0, items: [] } })); assert.equal(h.get('files-filter').hidden, true, 'no files at all: nothing to filter');
  }
});
