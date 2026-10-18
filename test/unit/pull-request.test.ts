import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePullRequestInput, pullRequestLabel, pullRequestNoun, pullRequestRef, pullRequestRefspec, pullRequestSource } from '../../src/git/pull-request';
import { parseRemoteUrl } from '../../src/git/remote-link';

const web = (url: string, hosts: unknown = {}) => parseRemoteUrl(url, hosts)!;
const github = web('https://github.com/o/r.git'), gitlab = web('git@gitlab.com:g/sub/r.git'), codeberg = web('https://codeberg.org/o/r'), cloud = web('git@bitbucket.org:t/r.git'), server = web('ssh://git@bb.example.com:7999/key/r.git', { 'bb.example.com': 'bitbucket' });

test('each host publishes the head of a pull request under its own ref, and Bitbucket Cloud publishes none', () => {
  assert.equal(pullRequestSource(github, 123), 'refs/pull/123/head');
  assert.equal(pullRequestSource(codeberg, 7), 'refs/pull/7/head');
  assert.equal(pullRequestSource(gitlab, 5), 'refs/merge-requests/5/head');
  assert.equal(pullRequestSource(server, 9), 'refs/pull-requests/9/from');
  assert.equal(pullRequestSource(cloud, 9), undefined);
  for (const number of [0, -1, 1.5, 10_000_000, Number.NaN]) assert.equal(pullRequestSource(github, number), undefined, String(number));
  assert.equal(pullRequestNoun(gitlab), 'merge request'); assert.equal(pullRequestNoun(github), 'pull request'); assert.equal(pullRequestNoun(server), 'pull request');
});

test('a fetched pull request lives under refs/gitpro/pr/<remote>/<number>, named PR #<number> in Compare', () => {
  assert.equal(pullRequestRef('origin', 123), 'refs/gitpro/pr/origin/123');
  assert.equal(pullRequestRef('team/fork', 4), 'refs/gitpro/pr/team/fork/4');
  for (const [remote, number] of [['', 1], ['-x', 1], ['a b', 1], ['a..b', 1], ['a:b', 1], ['x/', 1], ['.hidden', 1], ['x.lock', 1], ['x.', 1], ['origin', 0], ['origin', 1.5]] as const) assert.throws(() => pullRequestRef(remote, number), /Invalid pull request ref/, `${remote} ${number}`);
  assert.equal(pullRequestRefspec(github, 'origin', 123), '+refs/pull/123/head:refs/gitpro/pr/origin/123', 'forced, so a pull request pushed over is replaced');
  assert.equal(pullRequestRefspec(gitlab, 'upstream', 5), '+refs/merge-requests/5/head:refs/gitpro/pr/upstream/5');
  assert.equal(pullRequestRefspec(cloud, 'origin', 5), undefined);
  assert.equal(pullRequestLabel('refs/gitpro/pr/origin/123'), 'PR #123'); assert.equal(pullRequestLabel('refs/gitpro/pr/team/fork/4'), 'PR #4');
  for (const ref of ['refs/heads/main', 'refs/gitpro/pr/origin/0', 'refs/gitpro/pr/origin/12x', 'refs/gitpro/pr/123', 'refs/remotes/origin/123', 'refs/gitpro/pr/origin/12345678']) assert.equal(pullRequestLabel(ref), undefined, ref);
});

test('a pull request is typed as a number or as the link of this repository\'s page for it', () => {
  const ok = (input: string, target = github) => parsePullRequestInput(input, target);
  for (const input of ['123', ' 123 ', '#123', '!123']) assert.deepEqual(ok(input), { number: 123 }, input);
  for (const input of ['https://github.com/o/r/pull/123', 'https://github.com/o/r/pull/123/files', 'https://github.com/O/R/pull/123#discussion_r1', 'https://github.com/o/r/pull/123/', 'http://github.com/o/r/pull/123?x=1']) assert.deepEqual(ok(input), { number: 123 }, input);
  assert.deepEqual(ok('https://gitlab.com/g/sub/r/-/merge_requests/5', gitlab), { number: 5 });
  assert.deepEqual(ok('https://gitlab.com/g/sub/r/merge_requests/5/diffs', gitlab), { number: 5 });
  assert.deepEqual(ok('https://codeberg.org/o/r/pulls/8', codeberg), { number: 8 });
  // Bitbucket Server's link is not the path of its clone address, so only the host is compared.
  assert.deepEqual(ok('https://bb.example.com/projects/KEY/repos/r/pull-requests/12/overview', server), { number: 12 });
  const error = (input: string, target = github) => { const result = ok(input, target); assert.ok('error' in result, input); return result.error; };
  assert.match(error(''), /Enter the number/); assert.match(error('0'), /starts at 1/); assert.match(error('12345678'), /Enter a number/);
  assert.match(error('abc'), /Enter a number/); assert.match(error('12 34'), /Enter a number/); assert.match(error('-5'), /Enter a number/);
  assert.match(error('ftp://github.com/o/r/pull/1'), /Enter a number/); assert.match(error('javascript:alert(1)'), /Enter a number/);
  assert.match(error('https://github.com/o/r/issues/1'), /not the link of a pull request/);
  assert.match(error('https://github.com/o/other/pull/1'), /another repository/, 'a pull request of another repository is not fetched under this remote');
  assert.match(error('https://github.com/other/r/pull/1'), /another repository/);
  assert.match(error('https://evil.example.com/o/r/pull/1'), /another repository/);
  assert.match(error('https://github.com:8443/o/r/pull/1'), /another repository/, 'the port is part of the host');
  assert.match(error('https://gitlab.com/g/sub/r/-/merge_requests/5', github), /another repository/);
  assert.match(error('https://gitlab.com/g/sub/r/-/merge_requests/0', gitlab), /starts at 1/);
  assert.match(error('x', gitlab), /merge request/, 'GitLab says merge request');
});
