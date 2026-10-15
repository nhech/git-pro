import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MenuRouter, parseMenuContext } from '../../src/webviews/menu-context';

const oid = (digit: string) => digit.repeat(40);
const session = '3f2a9c1e-0000-4000-8000-123456789abc';
const argument = (extra: Record<string, unknown> = {}) => ({ webview: 'gitPro.history', webviewSection: 'commit', preventDefaultContextMenuItems: true, session, oid: oid('a'), ...extra });

test('a menu argument becomes plain bounded data, and anything else from the renderer is refused', () => {
  const context = parseMenuContext(argument({ index: 3, flag: true }));
  assert.deepEqual({ ...context.values }, { oid: oid('a'), index: 3, flag: true });
  assert.equal(context.webview, 'gitPro.history'); assert.equal(context.section, 'commit');
  assert.ok(Object.isFrozen(context) && Object.isFrozen(context.values));
  const many = Object.fromEntries([['webview', 'w'], ['webviewSection', 'commit'], ['session', 'abcdefgh'], ...Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])]);
  for (const bad of [undefined, null, 'text', [], 42, {}, argument({ session: 'x' }), argument({ session: undefined }), argument({ webviewSection: 'Commit' }), argument({ webview: 'bad webview' }),
    argument({ nested: { a: 1 } }), argument({ list: [1] }), argument({ big: 'x'.repeat(2049) }), argument({ nul: 'a\0b' }), argument({ fraction: 1.5 }), argument({ 'bad-key': 'x' }), many]) {
    assert.throws(() => parseMenuContext(bad), /Git Pro panel menu/, JSON.stringify(bad)?.slice(0, 60));
  }
  // JSON.parse makes "__proto__" an own key; it fails the key pattern like any other odd name and never reaches the result.
  assert.throws(() => parseMenuContext(JSON.parse('{"webview":"w","webviewSection":"commit","session":"abcdefgh","__proto__":{"admin":true}}')), /Git Pro panel menu/);
  assert.equal(({} as { admin?: boolean }).admin, undefined);
});

test('a commit menu command acts only for a live panel that shows that commit', () => {
  const router = new MenuRouter(), shown = new Set([oid('a')]);
  const registration = router.register('gitPro.history', session, { repositoryId: 'repo-1', knowsCommit: value => shown.has(value) });
  const found = router.commit(argument(), ['gitPro.history', 'gitPro.compare']);
  assert.equal(found.repositoryId, 'repo-1'); assert.equal(found.oid, oid('a'));
  assert.equal(router.commit(argument({ oid: oid('A') }), ['gitPro.history']).oid, oid('a'), 'a full commit ID is compared in lower case');
  assert.throws(() => router.commit(argument({ oid: oid('b') }), ['gitPro.history']), /no longer shown/, 'a commit this panel never showed');
  assert.throws(() => router.commit(argument({ oid: 'main' }), ['gitPro.history']), /Invalid full object ID/);
  assert.throws(() => router.commit(argument({ oid: undefined }), ['gitPro.history']), /Git Pro panel menu/);
  assert.throws(() => router.commit(argument({ webview: 'gitPro.compare' }), ['gitPro.compare']), /closed/, 'another panel type has no such session');
  assert.throws(() => router.commit(argument(), ['gitPro.compare']), /Git Pro panel menu/, 'the command is not offered to this panel type');
  assert.throws(() => router.commit(argument({ session: '00000000-0000-4000-8000-000000000000' }), ['gitPro.history']), /closed/);
  assert.throws(() => router.resolve(argument(), ['gitPro.history'], 'file'), /Git Pro panel menu/, 'a command for another kind of element');
  assert.equal(router.resolve(argument(), ['gitPro.history'], 'commit').panel.repositoryId, 'repo-1');
  registration.dispose();
  assert.throws(() => router.commit(argument(), ['gitPro.history']), /closed/, 'a disposed panel is gone');
  const replaced = router.register('gitPro.history', session, { repositoryId: 'repo-2', knowsCommit: () => true });
  registration.dispose();
  assert.equal(router.commit(argument(), ['gitPro.history']).repositoryId, 'repo-2', 'an old registration cannot remove a newer one');
  replaced.dispose();
  const silent = new MenuRouter(); silent.register('gitPro.history', session, { repositoryId: 'r' });
  assert.throws(() => silent.commit(argument(), ['gitPro.history']), /no longer shown/, 'a panel that cannot vouch for commits vouches for none');
});
