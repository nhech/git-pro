import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';

type Edit = (initial: string, title: string) => Promise<string | undefined>;

/** Runs the compiled editor against a fake `vscode`; `answer` is what the user clicks and `text` what is in the scratch document by then. */
async function run(answer: string | undefined, text: string, options: { closedByUser?: boolean; closeFails?: boolean; userSwitchedAway?: boolean } = {}) {
  const source = path.resolve(__dirname, '../../src/commands/message-editor.js');
  const shown: unknown[][] = [], commands: string[] = [];
  const document = { isClosed: options.closedByUser === true, getText: () => text };
  const vscode = {
    ViewColumn: { Beside: -2 },
    workspace: { openTextDocument: async () => document },
    window: {
      // After showTextDocument the scratch document is the active editor, unless the user moved to another file in between.
      get activeTextEditor() { return { document: options.userSwitchedAway ? { isClosed: false } : document }; },
      showTextDocument: async (...args: unknown[]) => { shown.push(args); },
      showInformationMessage: async () => answer
    },
    commands: { executeCommand: async (name: string) => { commands.push(name); if (options.closeFails) throw new Error('no editor'); } }
  };
  const exports: { editMessage?: Edit } = {};
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => { if (name === 'vscode') return vscode; throw new Error(name); } });
  const result = await exports.editMessage!('seed', 'Reword').then(value => ({ value }), (error: Error) => ({ error: error.message }));
  return { result, shown, commands };
}

test('the scratch message document is reverted and closed after Use Message, Cancel and a rejected message', async () => {
  const used = await run('Use Message', 'subject\n\nbody');
  assert.deepEqual(used.result, { value: 'subject\n\nbody' });
  assert.deepEqual(used.commands, ['workbench.action.revertAndCloseActiveEditor'], 'closed without a save prompt');
  assert.equal(used.shown.length, 2, 'it is brought forward again so the close acts on it, not on whatever the user switched to');

  for (const answer of ['Cancel', undefined]) {
    const cancelled = await run(answer, 'unused');
    assert.deepEqual(cancelled.result, { value: undefined });
    assert.deepEqual(cancelled.commands, ['workbench.action.revertAndCloseActiveEditor']);
  }

  const empty = await run('Use Message', '   ');
  assert.deepEqual(empty.result, { error: 'Enter a non-empty message of at most 65536 characters.' });
  assert.deepEqual(empty.commands, ['workbench.action.revertAndCloseActiveEditor'], 'a message that is refused does not leave its tab behind');
});

test('the scratch document is not closed when another editor became active in between, so that file is never reverted', async () => {
  const switched = await run('Use Message', 'kept', { userSwitchedAway: true });
  assert.deepEqual(switched.result, { value: 'kept' });
  assert.deepEqual(switched.commands, [], 'revertAndCloseActiveEditor would have hit the other editor');
});

test('nothing is closed twice when the user already closed the document, and a failed close never changes the outcome', async () => {
  const gone = await run('Use Message', 'ignored', { closedByUser: true });
  assert.deepEqual(gone.result, { value: undefined });
  assert.deepEqual(gone.commands, []);
  assert.equal(gone.shown.length, 1);

  const stuck = await run('Use Message', 'kept', { closeFails: true });
  assert.deepEqual(stuck.result, { value: 'kept' }, 'housekeeping failure is swallowed');
});
