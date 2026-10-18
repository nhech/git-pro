import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';
import { parseBlameFile } from '../../src/git/history/blame-file';

const a = 'a'.repeat(40), b = 'b'.repeat(40), none = '0'.repeat(40);
const meta = (author: string, time: number, summary: string) => `author ${author}\nauthor-mail <x@example.test>\nauthor-time ${time}\nauthor-tz +0000\ncommitter ${author}\ncommitter-mail <x@example.test>\ncommitter-time ${time}\ncommitter-tz +0000\nsummary ${summary}\nfilename f.txt\n`;
const now = 1_800_000_000_000, day = 86_400;
/** Lines 1-2 from a, 3 from b, 4 from a, 5 not committed; a is 3 days old, b is 400 days old. */
const sample = (author = 'Alice', summary = 'First') => Buffer.from([
  `${a} 1 1 2\n${meta(author, now / 1000 - 3 * day, summary)}\tl1\n${a} 2 2\n\tl2\n`, `${b} 1 3 1\n${meta('Bob', now / 1000 - 400 * day, 'Second')}\tl3\n`, `${a} 3 4 1\n\tl4\n`,
  `${none} 4 5 1\n${meta('Not Committed Yet', now / 1000, 'Version of f.txt')}\tl5\n`].join(''));

function harness(options: { dirty?: boolean; repo?: boolean; remote?: boolean; lines?: number } = {}) {
  const decorations = new Map<number, { range: { start: number; end: number }; text: string }[]>(), types: { id: number; options: Record<string, unknown>; disposed: boolean }[] = [];
  const handlers = new Map<string, (...args: unknown[]) => void>(), timers: (() => void)[] = [], statuses: string[] = [], errors: string[] = [], opened: string[] = [], clipboard: string[] = [], calls: unknown[][] = [];
  const document = { uri: { scheme: 'file', fsPath: '/work/repo/src/f.txt', toString: () => 'file:///work/repo/src/f.txt' }, isDirty: options.dirty ?? false, lineCount: options.lines ?? 6, lineAt: (line: number) => ({ range: { line } }) };
  const editor = { document, setDecorations: (type: { id: number }, items: { range: { start: { line: number }; end: { line: number } }; renderOptions: { before: { contentText: string } } }[]) => { decorations.set(type.id, Array.from(items, item => ({ range: { start: item.range.start.line, end: item.range.end.line }, text: item.renderOptions.before.contentText }))); } };
  const win = { activeTextEditor: editor as typeof editor | undefined, visibleTextEditors: [editor],
    createTextEditorDecorationType: (given: Record<string, unknown>) => { const type = { id: types.length, options: given, disposed: false, dispose: () => { type.disposed = true; } }; types.push(type); return type; },
    onDidChangeVisibleTextEditors: (callback: () => void) => { handlers.set('visible', callback); return { dispose: () => handlers.delete('visible') }; },
    setStatusBarMessage: (text: string) => { statuses.push(text); }, showErrorMessage: async (text: string) => { errors.push(text); } };
  class Range { constructor(readonly startLine: number, readonly startCharacter: number, readonly endLine: number, readonly endCharacter: number) {} get start() { return { line: this.startLine, character: this.startCharacter }; } get end() { return { line: this.endLine, character: this.endCharacter }; } }
  class MarkdownString { isTrusted: unknown; supportHtml = true; value = ''; appendMarkdown(text: string) { this.value += text; return this; } }
  class Hover { constructor(readonly contents: MarkdownString, readonly range: Range) {} }
  let provider: { provideHover(document: unknown, position: { line: number; character: number }): Promise<Hover | undefined> } | undefined;
  const subscribe = (name: string) => (callback: (...args: unknown[]) => void) => { handlers.set(name, callback); return { dispose: () => handlers.delete(name) }; };
  const vscode = { Range, MarkdownString, Hover, ThemeColor: class { constructor(readonly id: string) {} }, Uri: { parse: (value: string, strict: boolean) => { assert.equal(strict, true); return { value }; } },
    window: win, env: { clipboard: { writeText: async (value: string) => { clipboard.push(value); } }, openExternal: async (uri: { value: string }) => { opened.push(uri.value); return true; } },
    languages: { registerHoverProvider: (selector: unknown, given: typeof provider) => { assert.deepEqual(JSON.parse(JSON.stringify(selector)), { scheme: 'file' }); provider = given; return { dispose: () => { provider = undefined; } }; } },
    workspace: { onDidChangeTextDocument: subscribe('change'), onDidSaveTextDocument: subscribe('save'), onDidCloseTextDocument: subscribe('close') } };
  const state = { blame: sample() as Buffer | Error, reads: 0, oid: a as string | undefined, web: options.remote ?? true, url: 'https://example.test/o/r/commit/' + a as string | undefined };
  const history = { blameFile: async (id: string, relative: string, signal: AbortSignal) => { state.reads++; calls.push([id, relative, signal]); if (state.blame instanceof Error) throw state.blame; return parseBlameFile(state.blame); } };
  const repository = { id: 'repo', root: '/work/repo' };
  const registry = { resolveFile: async () => options.repo === false ? undefined : repository, list: () => [repository], store: { get: () => state.oid === undefined ? undefined : { oid: state.oid } }, onDidChange: subscribe('registry') };
  const links = { web: async () => state.web ? { kind: 'github', base: 'https://example.test/o/r' } : undefined, commit: async () => state.url };
  const source = path.resolve(__dirname, '../../src/editor/file-blame.js'), load = createRequire(source), exports: Record<string, unknown> = {};
  runInNewContext(readFileSync(source, 'utf8'), { exports, setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; }, clearTimeout: (id: number) => { timers[id - 1] = () => undefined; }, AbortController,
    require: (name: string) => name === 'vscode' ? vscode : name === '../security/paths' ? { canonicalFilePath: async (value: string) => value } : load(name) });
  const FileBlame = exports.FileBlame as new (...args: unknown[]) => { toggle(): Promise<void>; open(argument: unknown): void; copyHash(argument: unknown): Promise<void>; openOnRemote(argument: unknown): Promise<void>; dispose(): void };
  const opens: string[][] = [];
  const blame = new FileBlame(history, registry, links, (id: string, oid: string) => { opens.push([id, oid]); }, () => now);
  const flush = async () => { const due = timers.splice(0); for (const callback of due) callback(); for (let n = 0; n < 5; n++) await Promise.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); };
  const shown = () => types.map((type, index) => ({ index, items: decorations.get(type.id) ?? [] })).filter(entry => entry.items.length);
  return { blame, document, editor, win, handlers, types, state, calls, statuses, errors, opened, clipboard, opens, flush, shown, hover: (line: number, character = 0) => provider!.provideHover(document, { line, character }), provider: () => provider, timers };
}
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('Toggle File Blame puts hash, author and age before each block, tinted from warm to cool, and takes it away again', async () => {
  const h = harness();
  try {
    await h.blame.toggle();
    assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0]!.slice(0, 2), ['repo', 'src/f.txt']); assert.match(h.statuses[0]!, /reading blame/);
    // Lines 1-2 and 4 are a's (3 days: step 1), line 3 is b's (400 days: step 6), line 5 is not committed (the last type).
    const byType = h.shown().map(entry => [entry.index, entry.items.map(item => item.range.start)]);
    assert.deepEqual(byType, [[1, [0, 1, 3]], [6, [2]], [8, [4]]]);
    const text = (type: number, line: number) => h.shown().find(entry => entry.index === type)!.items.find(item => item.range.start === line)!.text.replace(/ /g, ' ');
    assert.equal(text(1, 0).trimEnd(), 'aaaaaaa Alice 3d'); assert.equal(text(1, 1).trim(), '', 'a second line of a block only carries the tint'); assert.equal(text(1, 3).trimEnd(), 'aaaaaaa Alice 3d');
    assert.equal(text(6, 2).trimEnd(), 'bbbbbbb Bob 1y'); assert.equal(text(8, 4).trimEnd(), 'Not committed yet');
    assert.ok(h.shown().every(entry => entry.items.every(item => item.range.start === item.range.end)), 'the text is injected before the line, over no characters');
    assert.equal(h.types.length, 9); assert.equal((h.types[8]!.options.before as { fontStyle: string }).fontStyle, 'italic');
    // Off: the decorations go.
    await h.blame.toggle(); assert.deepEqual(h.shown(), []);
    await h.blame.toggle(); assert.equal(h.calls.length, 2, 'and on again reads again');
  } finally { h.blame.dispose(); }
  assert.ok(h.types.every(type => type.disposed)); assert.equal(h.provider(), undefined); assert.equal(h.handlers.size, 0);
});

test('Toggle File Blame says what is missing, instead of annotating a file it cannot trust', async () => {
  const none = harness(); none.win.activeTextEditor = undefined; await assert.rejects(none.blame.toggle(), /Open a file in a repository first/); none.blame.dispose();
  const remote = harness(); (remote.document.uri as { scheme: string }).scheme = 'git'; await assert.rejects(remote.blame.toggle(), /Open a file in a repository first/); remote.blame.dispose();
  const dirty = harness({ dirty: true }); await assert.rejects(dirty.blame.toggle(), /Save the file first/); assert.equal(dirty.calls.length, 0); dirty.blame.dispose();
  const outside = harness({ repo: false }); await assert.rejects(outside.blame.toggle(), /not in an open repository/); outside.blame.dispose();
  // A read that fails turns blame off and says why, once.
  const failing = harness(); failing.state.blame = new Error('This file has too many lines to blame at once.');
  await failing.blame.toggle(); assert.match(failing.errors[0]!, /^Git Pro: /); assert.equal(failing.errors.length, 1); assert.deepEqual(failing.shown(), []);
  await failing.flush(); failing.state.blame = sample(); await failing.blame.toggle(); assert.ok(failing.shown().length, 'toggling again tries again'); failing.blame.dispose();
});

test('an edit takes the blame away until the file is saved, and a new HEAD or a revert reads it again', async () => {
  const h = harness();
  try {
    await h.blame.toggle(); assert.equal(h.state.reads, 1);
    // Typing: the lines no longer match, so the gutter goes at once and nothing is read.
    h.document.isDirty = true; h.handlers.get('change')!({ document: h.document, contentChanges: [{}] }); assert.deepEqual(h.shown(), []); await h.flush(); assert.equal(h.state.reads, 1);
    h.handlers.get('visible')!(); assert.deepEqual(h.shown(), [], 'an editor that appears while the file has edits stays bare');
    // Saving reads again, after a pause that edits in a row do not restart.
    h.document.isDirty = false; h.handlers.get('save')!(h.document); h.handlers.get('save')!(h.document); await h.flush(); assert.equal(h.state.reads, 2); assert.ok(h.shown().length);
    // Undoing back to the saved text is a change that leaves the file clean.
    h.document.isDirty = true; h.handlers.get('change')!({ document: h.document, contentChanges: [{}] }); h.document.isDirty = false; h.handlers.get('change')!({ document: h.document, contentChanges: [{}] }); await h.flush(); assert.equal(h.state.reads, 3);
    h.handlers.get('change')!({ document: h.document, contentChanges: [] }); await h.flush(); assert.equal(h.state.reads, 3, 'a change event without a change is nothing');
    // HEAD moves: read again; the same HEAD, or an event about another repository's state, is not a reason.
    h.handlers.get('registry')!(); await h.flush(); assert.equal(h.state.reads, 3);
    h.state.oid = b; h.handlers.get('registry')!(); await h.flush(); assert.equal(h.state.reads, 4); h.handlers.get('registry')!(); await h.flush(); assert.equal(h.state.reads, 4, 'once per move');
    h.state.oid = undefined; h.handlers.get('registry')!(); await h.flush(); const reads = h.state.reads; h.handlers.get('registry')!(); await h.flush(); assert.equal(h.state.reads, reads, 'an unborn branch does not read on every event');
    // Closing the file forgets it.
    h.handlers.get('close')!(h.document); assert.deepEqual(h.shown(), []); h.handlers.get('save')!(h.document); await h.flush(); assert.equal(h.state.reads, reads);
  } finally { h.blame.dispose(); }
});

test('a read that is overtaken by a newer one is ignored', async () => {
  const h = harness(); let release: (() => void) | undefined; const slow = new Promise<void>(resolve => { release = resolve; });
  try {
    await h.blame.toggle(); const reads = h.state.reads;
    const original = parseBlameFile(sample('Old Author', 'Old')), fresh = parseBlameFile(sample('New Author', 'New'));
    const history = (h.blame as unknown as { history: { blameFile: () => Promise<unknown> } }).history; let n = 0;
    const signals: AbortSignal[] = [];
    history.blameFile = async (...args: unknown[]) => { signals.push(args[2] as AbortSignal); n++; if (n === 1) { await slow; return original; } return fresh; };
    h.document.isDirty = false; h.handlers.get('save')!(h.document); await h.flush(); h.handlers.get('save')!(h.document); await h.flush();
    assert.equal(signals.length, 2); assert.equal(signals[0]!.aborted, true, 'the older read is told to stop'); assert.equal(signals[1]!.aborted, false);
    release!(); await h.flush();
    assert.ok(h.shown().length); assert.ok(h.shown().flatMap(entry => entry.items).some(item => item.text.includes('N')), 'the newer read shows');
    assert.ok(!h.shown().flatMap(entry => entry.items).some(item => item.text.replace(/ /g, ' ').includes('Old Author')), 'the older one does not');
    assert.equal(reads, 1);
  } finally { h.blame.dispose(); }
});

test('hovering the gutter opens a card with the author, the subject escaped, and links to that commit only', async () => {
  const h = harness();
  try {
    assert.equal(await h.hover(0), undefined, 'nothing before blame is on');
    await h.blame.toggle();
    const card = (await h.hover(1))!, text = card.contents.value;
    assert.match(text, /^\*\*Alice\*\*, 3 days ago \(\d{4}-\d{2}-\d{2}\)\n\nFirst\n\n`aaaaaaaaaa` · 2 lines · /);
    assert.deepEqual(plain(card.contents.isTrusted), { enabledCommands: ['gitPro.blame.openCommit', 'gitPro.blame.copyHash', 'gitPro.blame.openOnRemote'] }); assert.equal(card.contents.supportHtml, false);
    const argument = encodeURIComponent(JSON.stringify([{ repositoryId: 'repo', oid: a }]));
    for (const [command, label] of [['openCommit', 'Open Commit'], ['copyHash', 'Copy Hash'], ['openOnRemote', 'Open on Remote']]) assert.ok(text.includes(`[${label}](command:gitPro.blame.${command}?${argument})`), label);
    assert.deepEqual([card.range.startLine, card.range.startCharacter, card.range.endLine, card.range.endCharacter], [1, 0, 1, 0]);
    assert.equal((await h.hover(2))!.contents.value.includes(' · 1 line · '), true, 'one line is not "1 lines"');
    assert.match((await h.hover(4))!.contents.value, /^\*\*Not committed yet\*\*\n\nThis line is changed in your working tree\.$/, 'no links for what has no commit');
    // Only the first column opens it, only on a line of the file, only while the file matches the blame.
    assert.equal(await h.hover(1, 1), undefined); assert.equal(await h.hover(5), undefined); assert.equal(await h.hover(99), undefined);
    h.document.isDirty = true; assert.equal(await h.hover(1), undefined); h.document.isDirty = false;
    h.state.web = false; assert.doesNotMatch((await h.hover(1))!.contents.value, /Open on Remote/, 'a remote Git Pro has no links for offers no link');
  } finally { h.blame.dispose(); }
});

test('what a repository calls itself cannot become a link or markup in the card', async () => {
  const h = harness(); h.state.blame = sample('[Mallory](command:workbench.action.reloadWindow)', '<img src=x onerror=1> **bold** [click](command:evil)');
  try {
    await h.blame.toggle(); const text = (await h.hover(0))!.contents.value;
    assert.ok(text.includes('\\[Mallory\\]\\(command\\:workbench\\.action\\.reloadWindow\\)'), text); assert.ok(text.includes('\\<img src=x onerror=1\\> \\*\\*bold\\*\\* \\[click\\]\\(command\\:evil\\)'), text);
    assert.doesNotMatch(text.replace(/\\\[|\\\]|\\\(|\\\)/g, ''), /\[[^\]]*\]\(command:(?!gitPro\.blame\.)/, 'no link but Git Pro\'s own');
  } finally { h.blame.dispose(); }
});

test('the links of a card open, copy and show only a commit of a repository that is open', async () => {
  const h = harness(); const target = (extra: Record<string, unknown> = {}) => [{ repositoryId: 'repo', oid: a, ...extra }];
  try {
    h.blame.open(target()); assert.deepEqual(h.opens, [['repo', a]]);
    await h.blame.copyHash(target()); assert.deepEqual(h.clipboard, [a]);
    await h.blame.openOnRemote(target()); assert.deepEqual(h.opened, ['https://example.test/o/r/commit/' + a]);
    h.blame.open({ repositoryId: 'repo', oid: b }); assert.equal(h.opens.length, 2, 'a bare object is as good as a one-item list');
    for (const bad of [undefined, null, 'x', [], [{}], target({ repositoryId: 'elsewhere' }), target({ repositoryId: 5 }), target({ oid: 'HEAD' }), target({ oid: '--all' }), target({ oid: a.slice(1) }), target({ oid: 5 })]) {
      assert.throws(() => h.blame.open(bad)); await assert.rejects(h.blame.copyHash(bad)); await assert.rejects(h.blame.openOnRemote(bad));
    }
    assert.equal(h.opens.length, 2); assert.equal(h.clipboard.length, 1); assert.equal(h.opened.length, 1);
    h.state.url = undefined; await assert.rejects(h.blame.openOnRemote(target()), /gitPro\.remoteHosts/); assert.equal(h.opened.length, 1);
  } finally { h.blame.dispose(); }
});
