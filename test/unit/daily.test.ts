import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildMutationCommand, pathspecInput } from '../../src/git/command-builders';
import { parseCommitMessage } from '../../src/webviews/protocol';

test('mutation builders preserve literal filenames and reject untyped strategies and refs', () => {
  const files = ['-option.txt', 'a[1].txt', '日本語 file.txt'];
  const argv = buildMutationCommand({ kind: 'stage', paths: files });
  assert.ok(argv.includes('--literal-pathspecs') && argv.includes('--pathspec-from-file=-') && argv.includes('--pathspec-file-nul'));
  // Paths travel NUL-separated on stdin, so none can be read as an option or a glob.
  assert.ok(files.every(file => !argv.includes(file))); assert.deepEqual(pathspecInput(files).toString('utf8').split('\0').slice(0, -1), files);
  assert.throws(() => pathspecInput(['bad\0name']));
  assert.throws(() => buildMutationCommand({ kind: 'discard', paths: ['../outside'] }));
  assert.throws(() => buildMutationCommand({ kind: 'renameBranch', oldName: '--delete', newName: 'other' }));
  assert.throws(() => buildMutationCommand({ kind: 'integrate', strategy: 'invalid' as 'merge', oid: 'a'.repeat(40) }));
  assert.throws(() => buildMutationCommand({ kind: 'integrate', strategy: 'merge', oid: 'HEAD' }));
});

test('composer protocol accepts allowlisted data only and bounds hostile payloads', () => {
  const payload = { type: 'commit', session: 'current', repositoryId: 'repo', message: 'Title\n\nBody', amend: false, signoff: true, noVerify: false, push: false };
  assert.deepEqual(parseCommitMessage({ ...payload, command: 'shell' }), payload);
  for (const input of [null, { ...payload, push: 'true' }, { ...payload, message: 'x'.repeat(65537) }, { ...payload, message: 'NUL\0' }, { ...payload, type: 'execute' }]) assert.throws(() => parseCommitMessage(input));
});

class Element {
  value = ''; textContent = ''; checked = false; disabled = false; children: unknown[] = [];isConnected=true;focus():void{}setAttribute():void{}
  private readonly handlers = new Map<string, () => void>();
  addEventListener(type: string, listener: () => void): void { this.handlers.set(type, listener); }
  dispatchEvent(event: { type: string }): void { this.handlers.get(event.type)?.(); }
  replaceChildren(...children: unknown[]): void { this.children = children; }
}
test('composer script keeps repository drafts separate, resets options and clears successful busy commit', () => {
  const elements = new Map(['repository', 'staged', 'message', 'warning', 'amend', 'signoff', 'noVerify', 'commit', 'commit-label', 'advanced-label', 'push', 'history', 'clearHistory', 'result'].map(id => [id, new Element()]));
  const sent: Record<string, unknown>[] = [];
  let receive: ((event: { data: unknown }) => void) | undefined;
  const document = { body: { dataset: { session: 'session' },setAttribute:()=>undefined }, activeElement: elements.get('message'), getElementById: (id: string) => elements.get(id) };
  runInNewContext(readFileSync('media/commit.js', 'utf8'), {
    document, acquireVsCodeApi: () => ({ postMessage: (item: Record<string, unknown>) => sent.push(item) }),
    window: { addEventListener: (_: string, listener: typeof receive) => { receive = listener; } },
    Option: class { constructor(readonly text: string, readonly value: string) {} },
    Event: class { constructor(readonly type: string) {} }
  });
  const state = (repositoryId: string, message: string, busy = false, session = 'session') => receive!({ data: { type: 'state', session, repositoryId, repository: repositoryId, message, busy, staged: 1, operation: 'idle', subjectLimit: 72, history: ['<script>sentinel</script>'] } });
  const message = elements.get('message')!;
  state('repoA', 'draft A'); assert.equal(message.value, 'draft A');
  message.value = 'edited A'; message.dispatchEvent({ type: 'input' }); assert.equal(sent.at(-1)?.repositoryId, 'repoA');
  elements.get('amend')!.checked = true; state('repoB', 'draft B'); assert.equal(message.value, 'draft B'); assert.equal(elements.get('amend')!.checked, false);
  state('repoA', 'edited A'); assert.equal(message.value, 'edited A');
  state('intruder', 'wrong', false, 'expired'); assert.equal(message.value, 'edited A');
  elements.get('commit')!.dispatchEvent({ type: 'click' }); assert.equal(sent.at(-1)?.repositoryId, 'repoA');
  state('repoA', 'edited A', true); assert.equal(message.disabled, true);
  receive!({data:{type:'error',session:'expired',message:'wrong panel'}});assert.equal(message.disabled,true);assert.notEqual(elements.get('result')!.textContent,'wrong panel');
  for (const id of ['history', 'clearHistory', 'amend', 'signoff', 'noVerify']) assert.equal(elements.get(id)!.disabled, true);
  assert.equal(elements.get('commit-label')!.textContent, 'Committing…');
  const before = sent.length; elements.get('clearHistory')!.dispatchEvent({ type: 'click' });
  message.dispatchEvent({ type: 'input' }); assert.equal(sent.length, before);
  state('repoA', ''); assert.equal(message.value, ''); assert.equal(elements.get('commit')!.disabled, true);
  assert.equal(elements.get('history')!.children.length, 2); // History is text-only Option data.
});
