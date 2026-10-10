import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus, sameStatus, type FileChange, type StatusSnapshot } from '../../src/git/git-parser';
import { RepositoryStore } from '../../src/state/repository-store';

const oid = 'a'.repeat(40);
const snapshot = (changes: FileChange[], extra: Partial<StatusSnapshot> = {}): StatusSnapshot =>
  Object.freeze({ head: 'main', oid, upstream: 'origin/main', ahead: 0, behind: 0, changes: Object.freeze(changes), ...extra });
const change = (path: string, group: FileChange['group'] = 'working', status = 'M', originalPath?: string): FileChange =>
  Object.freeze({ path, group, status, ...(originalPath === undefined ? {} : { originalPath }) });

test('status equality ignores entry order but not content, group, rename source or branch facts', () => {
  const a = snapshot([change('a.txt'), change('b.txt', 'staged'), change('c.txt', 'untracked', '?')]);
  assert.equal(sameStatus(a, a), true);
  assert.equal(sameStatus(a, snapshot([change('a.txt'), change('b.txt', 'staged'), change('c.txt', 'untracked', '?')])), true);
  assert.equal(sameStatus(a, snapshot([change('c.txt', 'untracked', '?'), change('a.txt'), change('b.txt', 'staged')])), true, 'API and Git order entries differently');
  for (const different of [
    snapshot([change('a.txt'), change('b.txt', 'working'), change('c.txt', 'untracked', '?')]),
    snapshot([change('a.txt'), change('b.txt', 'staged', 'A'), change('c.txt', 'untracked', '?')]),
    snapshot([change('a.txt'), change('b.txt', 'staged')]),
    snapshot([change('a.txt'), change('b.txt', 'staged'), change('c.txt', 'untracked', '?'), change('d.txt')]),
    snapshot([change('a.txt'), change('b.txt', 'staged'), change('c.txt', 'untracked', '?')], { head: 'other' }),
    snapshot([change('a.txt'), change('b.txt', 'staged'), change('c.txt', 'untracked', '?')], { oid: 'b'.repeat(40) }),
    snapshot([change('a.txt'), change('b.txt', 'staged'), change('c.txt', 'untracked', '?')], { upstream: undefined }),
    snapshot([change('a.txt'), change('b.txt', 'staged'), change('c.txt', 'untracked', '?')], { ahead: 1 }),
    snapshot([change('a.txt'), change('b.txt', 'staged'), change('c.txt', 'untracked', '?')], { behind: 2 }),
  ]) assert.equal(sameStatus(a, different), false);
});

test('status equality distinguishes a rename source and counts duplicates', () => {
  const renamed = snapshot([change('new.txt', 'staged', 'R', 'old.txt')]);
  assert.equal(sameStatus(renamed, snapshot([change('new.txt', 'staged', 'R')])), false, 'owned reads carry the source; API snapshots do not');
  assert.equal(sameStatus(renamed, snapshot([change('new.txt', 'staged', 'R', 'other.txt')])), false);
  const twice = snapshot([change('a.txt'), change('a.txt'), change('b.txt')]);
  assert.equal(sameStatus(twice, snapshot([change('a.txt'), change('b.txt'), change('b.txt')])), false);
  assert.equal(sameStatus(twice, snapshot([change('b.txt'), change('a.txt'), change('a.txt')])), true);
});

test('parsed status of identical bytes is equal and a single new entry is not', () => {
  const bytes = (...records: string[]) => Buffer.from(records.map(record => `${record}\0`).join(''));
  const base = ['# branch.oid ' + oid, '# branch.head main', '? new.txt'];
  assert.equal(sameStatus(parseStatus(bytes(...base)), parseStatus(bytes(...base))), true);
  assert.equal(sameStatus(parseStatus(bytes(...base)), parseStatus(bytes(...base, '? other.txt'))), false);
});

test('store update is idempotent for identical content and still versions real changes', () => {
  const store = new RepositoryStore(); const events: string[] = []; store.onDidChange(id => events.push(id));
  const first = snapshot([change('a.txt')]);
  assert.equal(store.update('repo', first, 'idle'), true); const installed = store.get('repo')!;
  assert.equal(installed.version, 1); assert.equal(events.length, 1);
  assert.equal(store.update('repo', snapshot([change('a.txt')]), 'idle'), false);
  assert.equal(store.get('repo'), installed, 'same immutable object, so identity-based consumers can skip work'); assert.equal(events.length, 1);
  assert.equal(store.update('repo', snapshot([change('a.txt')]), 'merging'), true); assert.equal(store.get('repo')!.version, 2);
  assert.equal(store.update('repo', snapshot([change('a.txt'), change('b.txt')]), 'merging'), true); assert.equal(store.get('repo')!.version, 3);
  assert.equal(events.length, 3); store.dispose();
});
