import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitUrl, findReferences, parseRemoteUrl, referenceUrl, remoteHostMap } from '../../src/git/remote-link';
import { RemoteLinks, type RemoteSource } from '../../src/git/remote-links.service';

test('a remote address becomes the web address of its repository, in every form Git accepts, without credentials, SSH ports or .git', () => {
  const same = { kind: 'github', base: 'https://github.com/owner/repo' };
  for (const url of ['https://github.com/owner/repo.git', 'https://github.com/owner/repo', 'https://user:secret@github.com/owner/repo.git', 'git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo.git', 'ssh://git@github.com:2222/owner/repo.git', 'git://github.com/owner/repo.git', 'HTTPS://GitHub.com/owner/repo/', ' https://github.com/owner/repo.git ', 'https://github.com/owner/repo.git?x=1#y'])
    assert.deepEqual(parseRemoteUrl(url), same, url);
  assert.deepEqual(parseRemoteUrl('http://github.com/owner/repo.git'), { kind: 'github', base: 'http://github.com/owner/repo' }, 'a plain http remote keeps its scheme');
  assert.deepEqual(parseRemoteUrl('https://gitlab.com/group/sub/deep/repo.git'), { kind: 'gitlab', base: 'https://gitlab.com/group/sub/deep/repo' }, 'GitLab has subgroups');
  assert.deepEqual(parseRemoteUrl('git@bitbucket.org:team/repo.git'), { kind: 'bitbucket', base: 'https://bitbucket.org/team/repo' });
  assert.deepEqual(parseRemoteUrl('https://codeberg.org/me/repo'), { kind: 'gitea', base: 'https://codeberg.org/me/repo' });
  // An https port belongs to the web address, an SSH port does not.
  assert.deepEqual(parseRemoteUrl('https://git.example.com:8443/team/repo.git', { 'git.example.com': 'gitlab' }), { kind: 'gitlab', base: 'https://git.example.com:8443/team/repo' });
  assert.deepEqual(parseRemoteUrl('ssh://git@git.example.com:2222/team/repo.git', { 'GIT.example.com': 'gitea' }), { kind: 'gitea', base: 'https://git.example.com/team/repo' });
});

test('an address that is not a known host, not a repository, or not safe to link gives nothing', () => {
  for (const url of ['', '   ', 'https://example.com/owner/repo.git', 'https://github.com/owner', 'https://github.com/a/b/c', 'https://github.com/owner/..', 'https://github.com/own er/repo', 'file:///srv/repo.git', '/srv/repo.git', 'C:\\repo', '../repo', 'ftp://github.com/owner/repo', 'javascript:alert(1)', 'https://github.com/owner/repo\0', 'https://github.com/owner/<script>', 'x'.repeat(3000)])
    assert.equal(parseRemoteUrl(url), undefined, JSON.stringify(url).slice(0, 60));
  // The setting cannot make a host out of anything that is not one, or give it a kind that does not exist.
  assert.deepEqual(remoteHostMap({ 'git.example.com': 'gitlab', 'Other.Example': 'GITEA', 'bad host': 'gitlab', 'x.example': 'svn', 'y.example': 5 }), { 'git.example.com': 'gitlab' });
  assert.deepEqual(remoteHostMap('git.example.com'), {}); assert.deepEqual(remoteHostMap(['a']), {}); assert.deepEqual(remoteHostMap(null), {});
  assert.equal(parseRemoteUrl('https://git.example.com/team/repo', { 'git.example.com': 'svn' }), undefined);
  assert.equal(Object.keys(remoteHostMap(Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`h${index}.example`, 'gitlab'])))).length, 50, 'at most 50 hosts');
});

test('commit and reference pages follow each host\'s own layout and refuse anything that is not a hash or a number', () => {
  const hash = 'ABCDEF0123456789abcdef0123456789abcdef01';
  const github = parseRemoteUrl('https://github.com/o/r')!, gitlab = parseRemoteUrl('https://gitlab.com/g/s/r')!, bitbucket = parseRemoteUrl('https://bitbucket.org/t/r')!, gitea = parseRemoteUrl('https://codeberg.org/o/r')!;
  assert.equal(commitUrl(github, hash), `https://github.com/o/r/commit/${hash.toLowerCase()}`);
  assert.equal(commitUrl(gitlab, hash), `https://gitlab.com/g/s/r/-/commit/${hash.toLowerCase()}`);
  assert.equal(commitUrl(bitbucket, hash), `https://bitbucket.org/t/r/commits/${hash.toLowerCase()}`);
  assert.equal(commitUrl(gitea, 'abcdef0'), 'https://codeberg.org/o/r/commit/abcdef0');
  for (const bad of ['', 'abc', '--all', 'HEAD', `${hash}/../x`, 'g'.repeat(40), 'a'.repeat(65)]) assert.equal(commitUrl(github, bad), undefined, bad);
  assert.equal(referenceUrl(github, '#', 12), 'https://github.com/o/r/issues/12');
  assert.equal(referenceUrl(gitea, '#', 12), 'https://codeberg.org/o/r/issues/12');
  assert.equal(referenceUrl(gitlab, '#', 12), 'https://gitlab.com/g/s/r/-/issues/12');
  assert.equal(referenceUrl(gitlab, '!', 7), 'https://gitlab.com/g/s/r/-/merge_requests/7');
  assert.equal(referenceUrl(github, '!', 7), undefined, '! is a merge request only on GitLab');
  for (const [prefix, number] of [['?', 1], ['#', 0], ['#', -1], ['#', 1.5], ['#', 10_000_000], ['#', Number.NaN]] as const) assert.equal(referenceUrl(github, prefix, number), undefined, `${prefix}${number}`);
});

test('references are found in a commit message only where they stand alone, at most fifty', () => {
  const found = (message: string) => findReferences(message).map(item => `${item.prefix}${item.number}@${item.start}-${item.end}`);
  assert.deepEqual(found('Fix crash (#123)'), ['#123@11-15']);
  assert.deepEqual(found('Merge !7 and #8, then #9.'), ['!7@6-8', '#8@13-15', '#9@22-24']);
  assert.deepEqual(found('#1'), ['#1@0-2']);
  // Not references: part of a word, a path, a URL, an HTML entity, a colour, a longer number, an anchor, a heading.
  for (const message of ['abc#12', 'path/#12', 'https://example.com/page#12', 'a&#38;b', '#abc', '##12', '#12abc', '#12-3', '#12345678', 'v1.2#3', 'issue # 12', 'foo.#5', 'x!5', 'a-#4'])
    assert.deepEqual(found(message), [], message);
  assert.equal(findReferences(Array.from({ length: 80 }, (_, index) => `#${index + 1}`).join(' ')).length, 50);
});

function source(options: { remotes?: { name: string; fetch: string[] }[]; upstream?: string; hosts?: unknown; fail?: boolean }) {
  const reads = { remotes: 0 };
  const result: RemoteSource = {
    remotes: async () => { reads.remotes++; if (options.fail) throw new Error('git failed'); return options.remotes ?? []; },
    upstream: () => options.upstream, hosts: () => options.hosts ?? {},
  };
  return { result, reads };
}
const oid = 'a'.repeat(40);

test('the remote the branch follows wins, then origin, then the only remote; anything else has no links', async () => {
  const two = [{ name: 'origin', fetch: ['https://github.com/me/fork.git'] }, { name: 'upstream', fetch: ['https://github.com/org/project.git'] }];
  assert.equal(await new RemoteLinks(source({ remotes: two, upstream: 'upstream/main' }).result).commit('r', oid), `https://github.com/org/project/commit/${oid}`);
  assert.equal(await new RemoteLinks(source({ remotes: two, upstream: 'origin/main' }).result).commit('r', oid), `https://github.com/me/fork/commit/${oid}`);
  assert.equal(await new RemoteLinks(source({ remotes: two }).result).commit('r', oid), `https://github.com/me/fork/commit/${oid}`, 'origin without an upstream');
  assert.equal(await new RemoteLinks(source({ remotes: [{ name: 'work', fetch: ['git@gitlab.com:g/r.git'] }] }).result).commit('r', oid), `https://gitlab.com/g/r/-/commit/${oid}`, 'the only remote');
  assert.equal(await new RemoteLinks(source({ remotes: [{ name: 'a', fetch: ['https://github.com/a/a'] }, { name: 'b', fetch: ['https://github.com/b/b'] }] }).result).commit('r', oid), undefined, 'two remotes and none is origin or followed');
  // A remote whose name contains a slash is told apart from one whose name is its prefix.
  const nested = [{ name: 'team', fetch: ['https://github.com/short/x'] }, { name: 'team/fork', fetch: ['https://github.com/long/x'] }];
  assert.equal(await new RemoteLinks(source({ remotes: nested, upstream: 'team/fork/main' }).result).commit('r', oid), `https://github.com/long/x/commit/${oid}`);
  assert.equal(await new RemoteLinks(source({ remotes: [] }).result).web('r'), undefined);
  assert.equal(await new RemoteLinks(source({ remotes: [{ name: 'origin', fetch: [''] }] }).result).web('r'), undefined, 'a remote without a fetch address');
  assert.equal(await new RemoteLinks(source({ remotes: [{ name: 'origin', fetch: ['https://example.com/o/r'] }] }).result).web('r'), undefined, 'an unknown host');
  assert.equal(await new RemoteLinks(source({ fail: true }).result).web('r'), undefined, 'a Git failure is no links, not an error');
});

test('the hosts of the setting are used, and what a repository answers is kept for half a minute', async () => {
  const { result, reads } = source({ remotes: [{ name: 'origin', fetch: ['https://git.example.com/team/app.git'] }], hosts: { 'git.example.com': 'gitlab' } });
  let now = 1_000; const links = new RemoteLinks(result, () => now);
  assert.equal(await links.reference('r', '!', 3), 'https://git.example.com/team/app/-/merge_requests/3');
  assert.deepEqual(await links.pages('r'), { prefixes: '#!' });
  await links.commit('r', oid); await links.commit('r', oid); assert.equal(reads.remotes, 1, 'one read serves the next calls');
  now += 29_999; await links.web('r'); assert.equal(reads.remotes, 1);
  now += 2; await links.web('r'); assert.equal(reads.remotes, 2, 'read again after thirty seconds');
  const github = new RemoteLinks(source({ remotes: [{ name: 'origin', fetch: ['https://github.com/o/r'] }] }).result);
  assert.deepEqual(await github.pages('r'), { prefixes: '#' }, 'GitHub has no ! pages');
  assert.equal(await new RemoteLinks(source({}).result).pages('r'), undefined);
  assert.match(github.help, /gitPro\.remoteHosts/);
});
