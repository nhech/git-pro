import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

interface FakeEvent { key?: string; code?: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; clientX?: number; clientY?: number; target?: Element; data?: unknown; prevented: boolean; stopped: boolean; preventDefault(): void; stopPropagation(): void }
type Handler = (event: FakeEvent) => void;
const event = (init: Partial<FakeEvent> = {}): FakeEvent => { const value = { ...init, prevented: false, stopped: false, preventDefault() { value.prevented = true; }, stopPropagation() { value.stopped = true; } } as FakeEvent; return value; };
class Element {
  static active: Element | undefined;
  children: Element[] = []; text = ''; className = ''; id = ''; hidden = false; tabIndex = -1; title = ''; type = ''; checked = false; parent: Element | undefined;
  dataset: Record<string, string> = {}; attributes = new Map<string, string>(); listeners = new Map<string, Handler[]>(); style: Record<string, string> = {};
  constructor(readonly tag = 'div') {}
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.text = String(value); }
  get classList() {
    const list = () => this.className.split(' ').filter(Boolean);
    const api = { add: (value: string) => { if (!list().includes(value)) this.className = [...list(), value].join(' '); }, remove: (value: string) => { this.className = list().filter(item => item !== value).join(' '); },
      toggle: (value: string, force?: boolean) => { const on = force ?? !list().includes(value); if (on) api.add(value); else api.remove(value); return on; }, contains: (value: string) => list().includes(value) };
    return api;
  }
  append(...nodes: Element[]): void { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes: Element[]): void { for (const child of this.children) child.parent = undefined; this.children = []; this.text = ''; this.append(...nodes); }
  remove(): void { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined; } }
  setAttribute(key: string, value: string): void { this.attributes.set(key, String(value)); }
  getAttribute(key: string): string | null { return this.attributes.get(key) ?? null; }
  addEventListener(type: string, handler: Handler): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]); }
  fire(type: string, init: Partial<FakeEvent> = {}): FakeEvent { const value = event({ target: this, ...init }); for (const handler of this.listeners.get(type) ?? []) handler(value); return value; }
  focus(): void { Element.active = this; for (const handler of this.listeners.get('focus') ?? []) handler(event({ target: this })); }
  contains(target: Element | undefined): boolean { return target === this || this.children.some(child => child.contains(target)); }
  getBoundingClientRect() { return { left: 10, top: 10, width: 120, height: 22 }; }
  find(predicate: (node: Element) => boolean): Element | undefined { for (const child of this.children) { if (predicate(child)) return child; const nested = child.find(predicate); if (nested) return nested; } return undefined; }
  all(predicate: (node: Element) => boolean): Element[] { return this.children.flatMap(child => [...(predicate(child) ? [child] : []), ...child.all(predicate)]); }
}

const session = '12345678-1234-4234-9234-123456789abc';
function harness(focused = false) {
  Element.active = undefined;
  const elements = new Map<string, Element>(), created: string[] = [], sent: Record<string, unknown>[] = [], documentListeners = new Map<string, Handler[]>(), windowListeners = new Map<string, Handler>();
  const add = (id: string, tag = 'div', parent?: Element) => { const node = new Element(tag); node.id = id; elements.set(id, node); parent?.append(node); return node; };
  const body = new Element('body'); body.dataset.session = session;
  const banner = add('banner', 'header', body); for (const id of ['title', 'counter', 'sides', 'yours-side', 'theirs-side', 'operation-actions']) add(id, 'span', banner);
  add('status', 'div', body); const table = add('table', 'div', body); add('rows', 'div', table); add('empty', 'p', body); add('more', 'button', body); add('hint', 'footer', body); add('group-by-directory', 'input', body);
  for (const id of ['yours-header', 'theirs-header']) add(id, 'span', table).append(new Element('span'));
  for (const [id, action] of [['accept-yours', 'acceptYours'], ['accept-theirs', 'acceptTheirs'], ['merge', 'merge'], ['compare', 'compare']] as const) {
    const button = add(id, 'button', body); button.dataset.action = action; button.append(new Element('span'), new Element('span')); add(`reason-${action}`, 'span', body);
  }
  add('overflow', 'button', body).hidden = true;
  // `focused`: the tab was opened with focus, as an auto-open or the command without preserveFocus does.
  const document = { body, get activeElement() { return Element.active ?? body; }, getElementById: (id: string) => elements.get(id), createElement: (tag: string) => { created.push(tag); return new Element(tag); },
    hasFocus: () => focused, addEventListener: (type: string, handler: Handler) => documentListeners.set(type, [...(documentListeners.get(type) ?? []), handler]) };
  runInNewContext(readFileSync('media/conflicts.js', 'utf8'), { document, window: { addEventListener: (type: string, handler: Handler) => windowListeners.set(type, handler) }, innerWidth: 900, innerHeight: 600,
    // Messages cross the vm realm boundary as JSON, as they cross the webview boundary.
    acquireVsCodeApi: () => ({ postMessage: (value: Record<string, unknown>) => sent.push(JSON.parse(JSON.stringify(value)) as Record<string, unknown>) }) });
  const post = (data: Record<string, unknown>) => windowListeners.get('message')!(event({ data: { session, ...data } }));
  /** A keydown reaches the target, then bubbles to the document unless stopped. */
  const press = (target: Element | undefined, init: Partial<FakeEvent>, type = 'keydown') => {
    const value = target ? target.fire(type, init) : event(init);
    if (!value.stopped) for (const handler of documentListeners.get(type) ?? []) { handler(value); if (value.stopped) break; }
    return value;
  };
  const rows = () => elements.get('rows')!.children, row = (key: string) => rows().find(node => node.dataset.key === key)!;
  const operations = () => elements.get('operation-actions')!.children;
  return { elements, created, sent, body, post, press, rows, row, operations, last: (type: string) => sent.slice().reverse().find(value => value.type === type), documentListeners };
}
const key = (index: number) => `${String(index).padStart(3, '0')}${'k'.repeat(40)}`;
type RowInit = { key?: string; group?: string; path: string; kind?: string; yours?: string; theirs?: string; markers?: string; blocks?: number | null; binary?: boolean; mergeable?: boolean; unsupported?: string; mergeOpen?: boolean; workingFile?: boolean };
const conflict = (index: number, init: RowInit) => ({ key: key(index), group: 'unresolved', kind: 'bothModified', yours: 'modified', theirs: 'modified', markers: 'present', blocks: 2, binary: false, mergeable: true, mergeOpen: false, workingFile: true, ...init });
const operation = (extra: Record<string, unknown> = {}) => ({ kind: 'merging', title: 'Merging feature into main', yours: { label: 'Yours', ref: 'main', oid: '1'.repeat(40), flag: 'ours' }, theirs: { label: 'Theirs', ref: 'feature', oid: '9'.repeat(40), subject: 'Add <b>login</b>', flag: 'theirs' },
  conflicts: 3, canContinue: false, canSkip: false, canAbort: true, nativeOnly: false, editStop: false, ...extra });
const sample = () => [conflict(1, { path: 'src/<img src=x>.ts' }), conflict(2, { path: 'src/old.ts', kind: 'deletedByThem', theirs: 'deleted', mergeable: false, markers: 'unknown', blocks: null }), conflict(3, { path: 'assets/logo.png', binary: true, mergeable: false, markers: 'unknown', blocks: null })];
const state = (h: ReturnType<typeof harness>, rows: unknown[], extra: Record<string, unknown> = {}) => h.post({ type: 'state', revision: 7, repository: 'demo', groupByDirectory: false, operation: operation({ conflicts: rows.filter(item => (item as { group: string }).group === 'unresolved').length }), rows, truncated: false, message: '', ...extra });

test('Conflicts renderer draws repository text with textContent only, the WebStorm columns and the operation banner', () => {
  const h = harness();
  assert.equal(h.sent[0]?.type, 'ready'); assert.equal(h.sent[0]?.session, session);
  state(h, sample());
  assert.equal(h.created.some(tag => ['img', 'b', 'script', 'svg'].includes(tag)), false, 'no element comes from repository text');
  assert.equal(h.elements.get('title')!.textContent, 'Merging feature into main');
  assert.equal(h.elements.get('counter')!.textContent, '3 of 3 unresolved');
  assert.equal(h.elements.get('yours-side')!.textContent, 'Yours: main · 1111111');
  assert.equal(h.elements.get('theirs-side')!.textContent, 'Theirs: feature · 9999999 “Add <b>login</b>”');
  assert.equal(h.elements.get('yours-header')!.children[0]!.textContent, 'Yours (main)'); assert.equal(h.elements.get('yours-header')!.children[0]!.className, 'chip ours');
  assert.equal(h.elements.get('theirs-header')!.children[0]!.textContent, 'Theirs (feature)'); assert.equal(h.elements.get('theirs-header')!.children[0]!.className, 'chip theirs');
  assert.deepEqual(h.rows().map(node => node.getAttribute('role')), ['row', 'row', 'row', 'row']);
  assert.equal(h.rows()[0]!.getAttribute('aria-expanded'), 'true'); assert.equal(h.rows()[0]!.getAttribute('aria-label'), 'Unresolved, 3 files');
  const first = h.row(key(1));
  assert.deepEqual(first.children.map(cell => cell.getAttribute('role')), ['gridcell', 'gridcell', 'gridcell', 'gridcell', 'gridcell']);
  assert.equal(first.children[0]!.children[1]!.textContent, '<img src=x>.ts'); assert.equal(first.children[0]!.children[2]!.textContent, 'src', 'the directory is dimmed text after the name');
  assert.deepEqual(first.children.slice(1).map(cell => cell.textContent), ['Both modified', 'Modified', 'Modified', '2 conflicts left']);
  assert.equal(first.getAttribute('aria-label'), 'src/<img src=x>.ts, Both modified, Yours Modified, Theirs Modified, 2 conflicts left');
  assert.equal(h.row(key(2)).getAttribute('aria-label'), 'src/old.ts, Deleted by them, Yours Modified, Theirs Deleted, Choose Yours or Theirs');
  assert.deepEqual(h.row(key(2)).children.slice(3).map(cell => cell.textContent), ['Deleted', 'Choose Yours or Theirs'], 'a modify/delete row is resolved by choosing a side, never by "No markers left"');
  assert.equal(h.row(key(3)).children[4]!.textContent, 'Binary');
  const [continueButton, abort] = h.operations();
  assert.equal(continueButton!.textContent, 'Continue Merge…'); assert.equal(continueButton!.getAttribute('aria-disabled'), 'true'); assert.equal(continueButton!.title, 'Resolve and stage all conflicts first.');
  assert.equal(abort!.textContent, 'Abort Merge…'); assert.equal(h.operations().length, 2, 'a merge cannot skip');
  assert.equal(h.elements.get('accept-yours')!.getAttribute('aria-disabled'), 'true'); assert.equal(h.elements.get('reason-acceptYours')!.textContent, 'Select conflicted files first.');
  assert.equal(h.elements.get('hint')!.textContent, 'Select files, then Accept Yours, Accept Theirs or Merge… (Alt+Y, Alt+T, Alt+M)');
  h.post({ type: 'state', session: 'other', rows: [] }); assert.equal(h.rows().length, 4, 'a foreign session is ignored');
  h.post({ type: 'state', revision: 7, rows: [], operation: operation({ kind: 'rebasing', title: 'Rebasing feature onto main', conflicts: 2, canSkip: true, progress: { current: 3, total: 7 } }), message: '' });
  assert.deepEqual(h.operations().map(node => node.textContent), ['Continue Rebase…', 'Skip Commit…', 'Abort Rebase…']);
  assert.equal(h.elements.get('counter')!.textContent, 'Step 3 of 7 · 2 of 2 unresolved');
});

test('selection drives the Accept and Merge buttons, with reasons by kind, deletions named and the side mapping in the hint', () => {
  const h = harness(); state(h, sample());
  h.row(key(1)).fire('click');
  assert.deepEqual(h.last('select')?.keys, [key(1)]);
  const yours = h.elements.get('accept-yours')!, theirs = h.elements.get('accept-theirs')!, merge = h.elements.get('merge')!;
  assert.equal(yours.getAttribute('aria-disabled'), 'false'); assert.equal(merge.getAttribute('aria-disabled'), 'false');
  assert.equal(h.elements.get('hint')!.textContent, "1 selected · Accept Yours keeps main's version and stages it (git --ours)");
  theirs.focus(); assert.equal(h.elements.get('hint')!.textContent, "1 selected · Accept Theirs keeps feature's version and stages it (git --theirs)");
  h.row(key(2)).fire('click', { ctrlKey: true });
  assert.deepEqual(h.last('select')?.keys, [key(1), key(2)]);
  assert.equal(merge.getAttribute('aria-disabled'), 'true');
  assert.equal(merge.title, 'src/old.ts: Deleted by them — choose Accept Yours or Accept Theirs.'); assert.equal(h.elements.get('reason-merge')!.textContent, merge.title);
  assert.equal(theirs.children[1]!.textContent, 'Accept Theirs (delete 1 file)'); assert.equal(theirs.children[0]!.className, 'codicon codicon-trash');
  assert.equal(theirs.getAttribute('aria-label'), 'Accept Theirs for 2 files, deleting 1');
  assert.equal(yours.children[1]!.textContent, 'Accept Yours'); assert.equal(yours.children[0]!.className, 'codicon codicon-arrow-left', 'Yours is the left pane (owner decision Q1)');
  theirs.fire('click');
  assert.deepEqual(h.last('resolve'), { type: 'resolve', revision: 7, action: 'acceptTheirs', keys: [key(1), key(2)], session });
  const before = h.sent.length; merge.fire('click');
  assert.equal(h.sent.length, before, 'a blocked action sends nothing'); assert.equal(h.elements.get('status')!.textContent, merge.title);
  h.row(key(3)).fire('click', { ctrlKey: true });
  assert.equal(h.elements.get('compare')!.getAttribute('aria-disabled'), 'true');
  const many = Array.from({ length: 150 }, (_, index) => conflict(index + 10, { path: `f/${String(index).padStart(3, '0')}.ts` }));
  state(h, many);
  h.row(key(10)).fire('click'); h.row(key(159)).fire('click', { shiftKey: true });
  assert.equal((h.last('select')?.keys as unknown[]).length, 100, 'Shift ranges stop at the protocol bound');
  const all = h.press(h.row(key(12)), { key: 'a', ctrlKey: true });
  assert.equal(all.stopped, true, 'Select All stays inside the table'); assert.equal((h.last('select')?.keys as unknown[]).length, 100);
  assert.match(h.elements.get('status')!.textContent, /first 100 files/);
});

test('Alt+Y, Alt+T and Alt+M act on the selection and are stopped before the workbench sees them, keyups included', () => {
  const h = harness(); state(h, sample());
  h.row(key(1)).fire('click');
  const alt = h.press(h.row(key(1)), { key: 't', code: 'KeyT', altKey: true });
  assert.equal(alt.prevented, true); assert.equal(alt.stopped, true, 'stopPropagation keeps Alt+T from the Terminal menu mnemonic');
  assert.deepEqual(h.last('resolve'), { type: 'resolve', revision: 7, action: 'acceptTheirs', keys: [key(1)], session });
  assert.equal(h.press(undefined, { key: 't', altKey: true }, 'keyup').stopped, true); assert.equal(h.press(undefined, { key: 'Alt', altKey: false }, 'keyup').stopped, true);
  assert.equal(h.press(undefined, { key: 'x' }, 'keyup').stopped, false, 'only the mnemonic keyups are held back');
  h.press(h.row(key(1)), { key: 'y', code: 'KeyY', altKey: true }); assert.equal(h.last('resolve')?.action, 'acceptYours');
  h.press(h.elements.get('accept-yours'), { key: 'µ', code: 'KeyM', altKey: true });
  assert.deepEqual(h.last('open'), { type: 'open', revision: 7, action: 'merge', key: key(1), keys: [key(1)], session }, 'layout-independent: the physical key decides');
  h.row(key(2)).fire('click'); const count = h.sent.length;
  h.press(h.row(key(2)), { key: 'm', code: 'KeyM', altKey: true });
  assert.equal(h.sent.length, count); assert.equal(h.elements.get('status')!.textContent, 'src/old.ts: Deleted by them — choose Accept Yours or Accept Theirs.');
  h.post({ type: 'busy', busy: true });
  h.press(h.row(key(2)), { key: 'y', code: 'KeyY', altKey: true });
  assert.equal(h.sent.length, count); assert.equal(h.elements.get('status')!.textContent, 'Wait for the current action to finish.');
  assert.equal(h.elements.get('table')!.getAttribute('aria-busy'), 'true');
  const plain = h.press(h.row(key(2)), { key: 'y', code: 'KeyY' }); assert.equal(plain.stopped, false, 'plain letters are left alone');
});

test('Enter merges a mergeable row and otherwise moves to Accept with the reason; the row menu follows the kind', () => {
  const h = harness(); state(h, [...sample(), conflict(4, { path: 'clean.txt', markers: 'none', blocks: 0 })]);
  h.row(key(1)).focus(); h.press(h.row(key(1)), { key: 'Enter' });
  assert.deepEqual(h.last('open'), { type: 'open', revision: 7, action: 'merge', key: key(1), keys: [key(1)], session });
  const before = h.sent.filter(value => value.type === 'open').length;
  h.row(key(2)).fire('dblclick');
  assert.equal(h.sent.filter(value => value.type === 'open').length, before);
  assert.equal(h.elements.get('status')!.textContent, 'Deleted by them — choose Accept Yours or Accept Theirs.'); assert.equal(Element.active, h.elements.get('accept-yours'));
  // Right-click is VS Code's own menu: each row names itself and the revision it was drawn for, and the menu's items come from `when` clauses on these values.
  const tagged = (index: number) => JSON.parse(h.row(key(index)).getAttribute('data-vscode-context')!) as Record<string, unknown>, menuDrawn = () => h.body.children.some(node => node.className === 'context-menu');
  assert.deepEqual(tagged(1), { preventDefaultContextMenuItems: true, session, revision: 7, webviewSection: 'conflict', key: key(1), conflictUnresolved: true, conflictFile: true, conflictMarkable: false }, 'no Mark Resolved while markers remain');
  assert.equal(tagged(4).conflictMarkable, true); assert.equal(tagged(3).conflictMarkable, false, 'a binary row is resolved by choosing a side (N13)'); assert.equal(tagged(2).conflictMarkable, false, 'so is a modify/delete row');
  const selects = () => h.sent.filter(value => value.type === 'select').length, count = selects();
  h.row(key(4)).fire('contextmenu'); assert.equal(selects(), count + 1); assert.deepEqual(h.last('select'), { type: 'select', keys: [key(4)], session }, 'a right-click outside the selection selects that row first'); assert.equal(menuDrawn(), false, 'no menu of ours is drawn');
  h.row(key(4)).fire('contextmenu'); assert.equal(selects(), count + 1, 'a row already selected is not selected again');
  h.press(h.row(key(4)), { key: 'F10', shiftKey: true }); assert.equal(menuDrawn(), false, 'the menu key is left to the browser, which asks for the native menu');
  assert.equal(h.body.getAttribute('data-vscode-context'), JSON.stringify({ preventDefaultContextMenuItems: true }), 'outside a row nothing offers Cut, Copy and Paste');
  h.row(key(4)).fire('click'); h.elements.get('compare')!.fire('click');
  h.body.children.find(node => node.className === 'context-menu')!.children.find(node => node.dataset.menuAction === 'compareYoursTheirs')!.fire('click');
  assert.deepEqual(h.last('open'), { type: 'open', revision: 7, action: 'compareYoursTheirs', key: key(4), session });
});

test('focus moves to the next unresolved row after an action; resolved files, directories and the finished state follow WebStorm', () => {
  const h = harness();
  const a = conflict(1, { path: 'src/a.ts' }), b = conflict(2, { path: 'src/b.ts' }), c = conflict(3, { path: 'lib/c.ts' });
  state(h, [a, b, c]); h.row(key(2)).focus();
  state(h, [a, c, { ...b, key: key(9), group: 'resolved' }]);
  assert.equal(Element.active?.dataset.key, key(3), 'the row now at the resolved row\'s place takes focus');
  assert.deepEqual(h.rows().map(node => node.getAttribute('aria-label')?.split(',')[0]), ['Unresolved', 'src/a.ts', 'lib/c.ts', 'Resolved', 'src/b.ts']);
  assert.equal(h.row(key(9)).children[4]!.textContent, 'Resolved');
  assert.equal(h.elements.get('counter')!.textContent, '2 of 3 unresolved');
  state(h, [a, c, { ...b, key: key(9), group: 'resolved' }], { groupByDirectory: true });
  assert.deepEqual(h.rows().map(node => node.getAttribute('aria-label')?.split(',')[0]), ['Unresolved', 'lib', 'lib/c.ts', 'src', 'src/a.ts', 'Resolved', 'src', 'src/b.ts']);
  assert.equal(h.row(key(1)).children[0]!.children.some(node => node.className === 'dir'), false, 'grouped rows do not repeat the directory');
  assert.equal(h.elements.get('group-by-directory')!.checked, true);
  h.elements.get('group-by-directory')!.checked = false; h.elements.get('group-by-directory')!.fire('change');
  assert.deepEqual(h.last('setting'), { type: 'setting', groupByDirectory: false, session });
  const group = h.rows()[0]!; group.focus(); h.press(group, { key: 'ArrowLeft' });
  assert.equal(h.rows()[0]!.getAttribute('aria-expanded'), 'false'); assert.deepEqual(h.rows().map(node => node.dataset.key).slice(0, 2), ['group:unresolved', 'group:resolved']);
  h.press(h.rows()[0]!, { key: 'ArrowRight' }); h.press(h.rows()[0]!, { key: 'ArrowDown' }); assert.equal(Element.active?.dataset.key, 'dir:unresolved:lib');
  state(h, [{ ...a, key: key(8), group: 'resolved' }, { ...b, key: key(9), group: 'resolved' }, { ...c, key: key(7), group: 'resolved' }], { operation: operation({ conflicts: 0, canContinue: true }) });
  const [continueButton] = h.operations();
  assert.equal(continueButton!.className, 'primary'); assert.equal(continueButton!.getAttribute('aria-disabled'), null);
  assert.equal(Element.active, continueButton, 'the last conflict resolved: Continue takes focus');
  assert.equal(h.elements.get('counter')!.textContent, 'All conflicts resolved');
  const shortcut = h.press(h.row(key(8)), { key: 'Enter', ctrlKey: true });
  assert.equal(shortcut.stopped, true); assert.deepEqual(h.last('operation'), { type: 'operation', revision: 7, action: 'continue', session });
});

test('empty states, the stash finish and host selection', () => {
  const h = harness();
  h.post({ type: 'state', revision: 1, rows: [], operation: null, message: 'Open a trusted folder containing a Git repository.', groupByDirectory: false });
  assert.equal(h.elements.get('table')!.hidden, true); assert.equal(h.elements.get('empty')!.textContent, 'Open a trusted folder containing a Git repository.');
  assert.deepEqual(h.operations().map(node => node.dataset.operation), ['close']);
  h.post({ type: 'state', revision: 2, rows: [], operation: operation({ kind: 'idle', title: 'No merge conflicts', conflicts: 0, canAbort: false }), message: '' });
  assert.equal(h.elements.get('empty')!.textContent, 'No merge conflicts.'); assert.equal(h.elements.get('sides')!.hidden, true);
  h.post({ type: 'state', revision: 3, rows: [], operation: operation({ kind: 'bisecting', title: 'Bisect in progress — finish in native Git', conflicts: 0, canAbort: false, nativeOnly: true }), message: '' });
  assert.deepEqual(h.operations().map(node => node.dataset.operation), ['scm']); assert.equal(h.elements.get('empty')!.textContent, 'Bisect in progress — finish in native Git.');
  h.post({ type: 'state', revision: 4, rows: [conflict(1, { path: 'a.txt', group: 'resolved' })], operation: operation({ kind: 'idle', title: 'Conflicts from applying stash@{0} (stash kept)', conflicts: 0, canAbort: false, stash: { selector: 'stash@{0}', drop: true } }), message: '' });
  assert.deepEqual(h.operations().map(node => node.textContent), ['Drop Stash…', 'Close']);
  assert.equal(h.elements.get('counter')!.textContent, 'All conflicts resolved · stash@{0} was kept');
  h.operations()[0]!.fire('click'); assert.deepEqual(h.last('operation'), { type: 'operation', revision: 4, action: 'dropStash', session });
  state(h, sample());
  h.post({ type: 'select', keys: [key(3), 'unknown'] });
  assert.deepEqual(h.last('select')?.keys, [key(3)]); assert.equal(Element.active?.dataset.key, key(3));
  h.post({ type: 'error', message: 'Conflicts changed. Review again.' });
  assert.equal(h.elements.get('status')!.textContent, 'Conflicts changed. Review again.'); assert.equal(h.elements.get('status')!.className, 'error');
});

const four = () => ['a', 'b', 'c', 'd'].map((name, index) => conflict(index + 1, { path: `${name}.ts` }));
test('Shift+Arrow extends from the focused row when no anchor is set, and after the anchor row was resolved', () => {
  const h = harness(); state(h, four());
  // Reached with Tab: focus only, no click and no Space.
  h.row(key(1)).focus();
  h.press(h.row(key(1)), { key: 'ArrowDown', shiftKey: true }); h.press(h.row(key(2)), { key: 'ArrowDown', shiftKey: true });
  assert.deepEqual(h.last('select')?.keys, [key(1), key(2), key(3)]);
  h.press(h.row(key(3)), { key: 't', code: 'KeyT', altKey: true });
  assert.deepEqual(h.last('resolve')?.keys, [key(1), key(2), key(3)]);
  // a.ts (the anchor) is resolved: its key changes, so the next range starts at the focused row again instead of selecting one row.
  state(h, [conflict(2, { path: 'b.ts' }), conflict(3, { path: 'c.ts' }), conflict(4, { path: 'd.ts' }), conflict(9, { path: 'a.ts', group: 'resolved' })]);
  h.row(key(4)).focus(); h.press(h.row(key(4)), { key: 'ArrowUp', shiftKey: true });
  assert.deepEqual(h.last('select')?.keys, [key(3), key(4)]);
});

test('Alt mnemonics follow the typed letter on any layout and leave other keys to the workbench', () => {
  const h = harness(); state(h, sample()); h.row(key(1)).fire('click');
  const dvorak = h.press(h.row(key(1)), { key: 'y', code: 'KeyT', altKey: true });
  assert.equal(h.last('resolve')?.action, 'acceptYours', 'Dvorak: the key typing "y" is Accept Yours'); assert.equal(dvorak.stopped, true);
  const count = h.sent.length;
  const qwertz = h.press(h.row(key(1)), { key: 'z', code: 'KeyY', altKey: true });
  assert.equal(h.sent.length, count); assert.equal(qwertz.stopped, false, 'QWERTZ Alt+Z stays Toggle Word Wrap'); assert.equal(qwertz.prevented, false);
  const azerty = h.press(h.row(key(1)), { key: ',', code: 'KeyM', altKey: true });
  assert.equal(h.sent.length, count); assert.equal(azerty.stopped, false, 'AZERTY Alt+, is not Merge…');
  h.press(h.row(key(1)), { key: '†', code: 'KeyT', altKey: true });
  assert.equal(h.last('resolve')?.action, 'acceptTheirs', 'macOS Option+T types † and falls back to the physical key');
});

test('the selection follows focus after an action, and a tab opened with focus selects the first unresolved row', () => {
  const h = harness(true), [a, b, c] = four();
  state(h, [a!, b!, c!]);
  assert.equal(Element.active?.dataset.key, key(1), 'focus enters the table at once'); assert.deepEqual(h.last('select')?.keys, [key(1)]);
  assert.equal(h.elements.get('accept-theirs')!.getAttribute('aria-disabled'), 'false', 'Accept works without a click or Space');
  h.press(h.row(key(1)), { key: 't', code: 'KeyT', altKey: true });
  state(h, [b!, c!, { ...a!, key: key(9), group: 'resolved' }]);
  assert.equal(Element.active?.dataset.key, key(2)); assert.deepEqual(h.last('select')?.keys, [key(2)], 'the row now in its place is selected and published');
  h.press(h.row(key(2)), { key: 't', code: 'KeyT', altKey: true });
  assert.deepEqual(h.last('resolve'), { type: 'resolve', revision: 7, action: 'acceptTheirs', keys: [key(2)], session }, 'Alt+T repeats on the next file');
  const later = harness(); state(later, [a!, b!]);
  assert.equal(Element.active, undefined, 'a tab revealed without focus does not take it'); assert.deepEqual(later.last('select')?.keys, []);
  const down = later.press(undefined, { key: 'ArrowDown' });
  assert.equal(down.prevented, true); assert.equal((Element.active as Element | undefined)?.dataset.key, key(1), 'the arrows enter the table from the page');
});

test('the Compare and More Actions menus return focus to their button; Use Column Layout and Mark Resolved follow their rules', () => {
  const h = harness(); state(h, [...sample(), conflict(4, { path: 'clean.txt', markers: 'none', blocks: 0 }), conflict(5, { path: 'kept.txt', kind: 'deletedByThem', theirs: 'deleted', markers: 'none', blocks: 0, mergeable: false })]);
  const compare = h.elements.get('compare')!, overflow = h.elements.get('overflow')!;
  h.row(key(4)).fire('click'); compare.fire('click');
  assert.equal(h.press(h.body.children.find(node => node.className === 'context-menu'), { key: 'Escape' }).stopped, true); assert.equal(Element.active, compare, 'Escape returns to the Compare button');
  compare.fire('click'); const menu = h.body.children.find(node => node.className === 'context-menu')!;
  menu.fire('keydown', { key: 'Tab' }); assert.equal(Element.active, compare, 'Tab closes it the same way');
  assert.equal(overflow.hidden, true, 'hidden while VS Code has no merge.columnLayout');
  state(h, [...sample(), conflict(4, { path: 'clean.txt', markers: 'none', blocks: 0 })], { columnLayout: true });
  assert.equal(overflow.hidden, false); overflow.fire('click');
  const more = h.body.children.find(node => node.className === 'context-menu')!;
  assert.deepEqual(more.children.map(node => node.textContent), ['Use Column Layout in Merge Editor']);
  more.children[0]!.fire('click');
  assert.deepEqual(h.last('columnLayout'), { type: 'columnLayout', session }); assert.equal(Element.active, overflow);
  const markable = (index: number) => (JSON.parse(h.row(key(index)).getAttribute('data-vscode-context')!) as { conflictMarkable: boolean }).conflictMarkable;
  state(h, [...sample(), conflict(4, { path: 'clean.txt', markers: 'none', blocks: 0 }), conflict(5, { path: 'kept.txt', kind: 'deletedByThem', theirs: 'deleted', markers: 'none', blocks: 0, mergeable: false })]);
  assert.equal(markable(4), true); assert.equal(markable(5), false, 'a modify/delete row with no markers is still a choice of side');
  assert.equal(h.row(key(5)).children[4]!.textContent, 'Choose Yours or Theirs');
});
