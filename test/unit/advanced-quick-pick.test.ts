import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

type Item = { label: string; plainLabel: string; description: string; action: string };
/** advanced.commands.js in a vm: the Resolve Conflict quick pick over a scripted preview, recording the items, modals, messages and resolve calls. */
function quickPick(operation: string, preview: { readonly entries: readonly { readonly stage: number }[]; readonly text?: string; readonly markers: boolean }, choice: string) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'git-pro-resolve-pick-'))); writeFileSync(path.join(root, 'logo.bin'), '\0x');
  class Uri { constructor(readonly scheme: string, readonly fsPath: string) {} static file(value: string) { return new Uri('file', value); } }
  const picks: { items: Item[]; placeHolder: string }[] = [], warnings: { text: string; detail: string }[] = [], infos: string[] = [], opened: unknown[] = [], resolved: unknown[][] = [];
  const vscode = { Uri, window: {
    showQuickPick: async (items: Item[], options: { placeHolder: string }) => { picks.push({ items, placeHolder: options.placeHolder }); return items.find(item => item.action === choice); },
    showWarningMessage: async (text: string, options: { detail: string }, button: string) => { warnings.push({ text, detail: options.detail }); return button; },
    showInformationMessage: async (text: string) => { infos.push(text); } },
    commands: { executeCommand: async (...args: unknown[]) => { opened.push(args); } } };
  const full = { snapshot: { operation }, path: 'logo.bin', ...preview };
  class ConflictsService { preview = async () => full; resolve = async (...args: unknown[]) => { resolved.push(args.slice(1)); }; }
  const source = path.resolve(__dirname, '../../src/commands/advanced.commands.js'), load = createRequire(source), exports: Record<string, unknown> = {};
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : name === './message-editor' ? {} : name === '../git/conflicts/conflicts.service' ? { ConflictsService } : name === '../git/advanced/lease.service' ? { LeaseService: class {} } : name === '../editor/open-files' ? { refuseUnsaved: async () => undefined } : load(name) });
  const advanced = { git: { registry: { active: { id: 'owned' } }, repository: () => ({ root }), authorizePath: async (_id: string, relative: string) => path.join(root, relative) } };
  const instance = new (exports.AdvancedCommands as new (...args: unknown[]) => { conflict(arg: unknown): Promise<void> })(advanced, {}, {}, {}, { path: '/owned-extension' });
  return { run: () => instance.conflict({ repositoryId: 'owned', change: { path: 'logo.bin' } }), picks, warnings, infos, opened, resolved, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
/** The items are built in the vm's realm; Array.from makes the list comparable. */
const actions = (items: Item[]) => Array.from(items, item => item.action);

test('the Resolve Conflict quick pick offers Mark Resolved and Accept Both only for a text both-sides conflict; elsewhere Accept stages the side (N13)', async () => {
  const all = [{ stage: 1 }, { stage: 2 }, { stage: 3 }];
  const text = quickPick('rebasing', { entries: all, text: 'resolved\n', markers: false }, 'mark');
  try {
    await text.run();
    assert.deepEqual(actions(text.picks[0]!.items), ['editor', 'baseYours', 'baseTheirs', 'yours', 'theirs', 'both', 'mark']);
    assert.equal(text.picks[0]!.placeHolder, 'Choose a side → review the file → Mark Resolved → Continue');
    assert.equal(text.picks[0]!.items.find(item => item.action === 'yours')!.description, 'Use commit being replayed; review before staging');
    assert.deepEqual(text.resolved, [['mark', false]]);
  } finally { text.cleanup(); }
  for (const [name, preview] of [['binary', { entries: all, markers: false }], ['deleted by Theirs', { entries: [{ stage: 1 }, { stage: 3 }], text: 'mine\n', markers: false }], ['added by Yours', { entries: [{ stage: 3 }], text: 'mine\n', markers: false }]] as const) {
    const h = quickPick('rebasing', preview, 'yours');
    try {
      await h.run();
      assert.deepEqual(actions(h.picks[0]!.items), ['editor', 'baseYours', 'baseTheirs', 'yours', 'theirs'], name);
      assert.equal(h.picks[0]!.placeHolder, 'Choose a side; Accept stages it → Continue', name);
      assert.equal(h.picks[0]!.items.find(item => item.action === 'yours')!.description, 'Use commit being replayed and stage it', name);
      assert.match(h.warnings[0]!.detail, /Accept replaces the working file with that side and stages it: binary and one-sided conflicts have no Mark Resolved\.$/, name);
      // During a rebase Yours is Git --theirs.
      assert.deepEqual(h.resolved, [['incoming', false]], name);
      assert.deepEqual(h.infos, ['Conflict resolved with Yours. Review staged changes before continuing.'], name); assert.deepEqual(h.opened, [], name);
    } finally { h.cleanup(); }
  }
  const idle = quickPick('idle', { entries: [{ stage: 1 }, { stage: 2 }], text: 'kept\n', markers: false }, 'theirs');
  try {
    await idle.run();
    assert.equal(idle.picks[0]!.placeHolder, 'Choose a side; Accept stages it → review staged changes');
    assert.equal(idle.picks[0]!.items.find(item => item.action === 'theirs')!.label, '$(trash) Accept Theirs (delete file)', 'a side with no file still resolves as deletion');
    assert.deepEqual(idle.resolved, [['incoming', false]]); assert.deepEqual(idle.infos, ['Conflict resolved as deletion. Review staged changes before continuing.']);
  } finally { idle.cleanup(); }
});
