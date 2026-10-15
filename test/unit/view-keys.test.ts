import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';

test('a view\'s context key follows the kind of its one selected item, so a shortcut is scoped to what it acts on', () => {
  const executed: unknown[][] = [];
  const vscode = { commands: { executeCommand: async (...args: unknown[]) => { executed.push(args); } } };
  const source = path.resolve(__dirname, '../../src/views/view-keys.js'), load = createRequire(source), exports: Record<string, unknown> = {};
  runInNewContext(readFileSync(source, 'utf8'), { exports, require: (name: string) => name === 'vscode' ? vscode : load(name) });
  const listeners: (() => void)[] = []; let disposed = false;
  const view = { selection: [] as string[], onDidChangeSelection: (listener: () => void) => { listeners.push(listener); return { dispose: () => { disposed = true; } }; } };
  const subscription = (exports.trackSelection as (...args: unknown[]) => { dispose(): void })(view, 'gitPro.example.item', (item: string) => item === 'unnamed' ? undefined : `kind.${item}`);
  const key = () => executed.at(-1);
  assert.deepEqual(key(), ['setContext', 'gitPro.example.item', ''], 'nothing selected');
  view.selection = ['stash']; listeners[0]!(); assert.deepEqual(key(), ['setContext', 'gitPro.example.item', 'kind.stash']);
  view.selection = ['stash', 'tag']; listeners[0]!(); assert.deepEqual(key(), ['setContext', 'gitPro.example.item', ''], 'several items: no shortcut applies');
  view.selection = ['unnamed']; listeners[0]!(); assert.deepEqual(key(), ['setContext', 'gitPro.example.item', ''], 'an item without a kind');
  subscription.dispose(); assert.equal(disposed, true);
});
