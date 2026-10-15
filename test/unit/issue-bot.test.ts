import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

type Args = Record<string, unknown>;
type Bot = {
  parseCommand(body: string): Record<string, unknown> | undefined; parseForm(body: string): Record<string, string>; issueType(sections: Record<string, string>): string | undefined;
  missingBugFields(sections: Record<string, string>): string[]; areaLabels(title: string, body: string): string[];
  onIssueOpened(input: unknown): Promise<void>; onIssueComment(input: unknown): Promise<void>; onIssueClosed(input: unknown): Promise<void>;
  HEADINGS: Record<string, string>; MARKER: string;
};
const bot = createRequire(path.resolve('package.json'))('./.github/scripts/issue-bot.cjs') as Bot;

const bugBody = (overrides: Record<string, string> = {}) => {
  const fields: Record<string, string> = { 'Git Pro version': '0.2.1', 'VS Code version': '1.141.0', 'Operating system': 'Windows', 'Git version': '_No response_', 'Where is the workspace?': 'Local folder',
    'Steps to reproduce': '1. Open the repository and start the operation', 'Expected behavior': '_No response_', 'Actual behavior': 'The Conflicts tab stays empty', 'Git Pro output': '_No response_', ...overrides };
  return Object.entries(fields).map(([heading, value]) => `### ${heading}\n\n${value}`).join('\n\n');
};

/** A recording stand-in for the octokit client that actions/github-script passes in. */
function fakeGitHub(options: { labels?: string[]; comments?: { body: string; user: { type: string } }[]; issues?: number[] } = {}) {
  const calls: { method: string; args: Args }[] = [];
  const labels = new Set(options.labels ?? ['bug', 'enhancement', 'question', 'duplicate']);
  const record = (method: string, args: Args) => { calls.push({ method, args }); };
  const github = { rest: {
    issues: {
      listLabelsForRepo: async () => ({ data: [...labels].map(name => ({ name })) }),
      createLabel: async (args: Args) => { record('createLabel', args); labels.add(String(args.name)); return {}; },
      addLabels: async (args: Args) => { record('addLabels', args); return {}; },
      removeLabel: async (args: Args) => { record('removeLabel', args); return {}; },
      listComments: async () => ({ data: options.comments ?? [] }),
      createComment: async (args: Args) => { record('createComment', args); return {}; },
      update: async (args: Args) => { record('update', args); return {}; },
      get: async (args: Args) => { record('get', args); if (!(options.issues ?? []).includes(Number(args.issue_number))) throw Object.assign(new Error('Not Found'), { status: 404 }); return { data: {} }; },
    },
    reactions: { createForIssueComment: async (args: Args) => { record('react', args); return {}; } },
  } };
  const of = (method: string) => calls.filter(call => call.method === method).map(call => call.args);
  return { github, calls, labels, of };
}

const context = (eventName: string, payload: Record<string, unknown>) => ({ eventName, repo: { owner: 'nhech', repo: 'git-pro' }, payload });
const issue = (extra: Record<string, unknown> = {}) => ({ number: 12, state: 'open', title: 'Conflicts tab is empty', body: bugBody(), user: { login: 'reporter', type: 'User' }, author_association: 'NONE', labels: [{ name: 'bug' }], ...extra });
const comment = (body: string, association: string, login = 'maintainer', type = 'User') => ({ id: 99, body, author_association: association, user: { login, type } });
const labelsAdded = (args: Args[]) => args.flatMap(item => item.labels as string[]);

test('slash commands are parsed strictly from the first non-empty, unquoted line', () => {
  assert.deepEqual(bot.parseCommand('/resolve'), { name: 'resolve' });
  assert.deepEqual(bot.parseCommand('\n  /resolve v0.2.1  \nthanks'), { name: 'resolve', version: '0.2.1' });
  assert.deepEqual(bot.parseCommand('/RESOLVE 1.0.0'), { name: 'resolve', version: '1.0.0' });
  assert.equal(bot.parseCommand('/resolve soon'), undefined, 'a version must be x.y.z');
  assert.equal(bot.parseCommand('/resolve 0.2'), undefined);
  assert.deepEqual(bot.parseCommand('/duplicate #34'), { name: 'duplicate', number: 34 });
  assert.deepEqual(bot.parseCommand('/duplicate 34'), { name: 'duplicate', number: 34 });
  assert.equal(bot.parseCommand('/duplicate #abc'), undefined);
  assert.deepEqual(bot.parseCommand('/needs-info please share the output'), { name: 'needs-info', note: 'please share the output' });
  assert.deepEqual(bot.parseCommand('/triaged'), { name: 'triaged' });
  assert.equal(bot.parseCommand('/triaged now'), undefined);
  assert.deepEqual(bot.parseCommand('/label area: tools, bug'), { name: 'label', labels: ['area: tools', 'bug'] });
  assert.equal(bot.parseCommand('/label a, b, c, d, e, f'), undefined, 'at most five labels');
  assert.equal(bot.parseCommand('/label `rm -rf`'), undefined, 'label names are restricted to plain characters');
  assert.equal(bot.parseCommand('> /resolve'), undefined, 'a quoted command does not run');
  assert.equal(bot.parseCommand('Looks fixed.\n/resolve'), undefined, 'the command must come first');
  assert.equal(bot.parseCommand('/delete-everything'), undefined);
  assert.equal(bot.parseCommand('/resolved'), undefined);
  assert.equal(bot.parseCommand(''), undefined);
});

test('issue forms are parsed by heading and classified without reading free text', () => {
  const sections = bot.parseForm(bugBody());
  assert.equal(sections['Git Pro version'], '0.2.1');
  assert.equal(sections['Git version'], '', '_No response_ counts as empty');
  assert.equal(bot.issueType(sections), 'bug');
  assert.deepEqual(bot.missingBugFields(sections), []);
  assert.deepEqual(bot.missingBugFields(bot.parseForm(bugBody({ 'Steps to reproduce': '_No response_', 'Operating system': '' }))).sort(), ['os', 'steps']);
  assert.equal(bot.issueType(bot.parseForm('### Problem to solve\n\nx\n\n### Proposed solution\n\ny')), 'enhancement');
  assert.equal(bot.issueType(bot.parseForm('### Your question\n\nhow?')), 'question');
  assert.equal(bot.issueType(bot.parseForm('A plain description of a crash')), undefined);
  assert.deepEqual(bot.parseForm('line one\r\n### Heading\r\n\r\nvalue\r\n'), { Heading: 'value' });
});

test('area labels follow the report text, most specific first and at most two', () => {
  assert.deepEqual(bot.areaLabels('Accept Theirs keeps my version', 'merge editor opens empty'), ['area: conflicts']);
  assert.deepEqual(bot.areaLabels('Compare with Current fails', 'after a rebase and a stash'), ['area: compare', 'area: advanced']);
  assert.deepEqual(bot.areaLabels('Git Pro crashes', 'on a Tuesday'), []);
  assert.deepEqual(bot.areaLabels('Stage all is slow', 'many untracked files, discard too, plus branch checkout and history').length, 2);
});

test('a complete bug report gets triage labels, the missing labels are created, and one welcome comment', async () => {
  const fake = fakeGitHub();
  await bot.onIssueOpened({ github: fake.github, context: context('issues', { action: 'opened', issue: issue() }) });
  assert.deepEqual(fake.of('createLabel').map(item => item.name).sort(), ['area: conflicts', 'needs-triage']);
  assert.deepEqual(labelsAdded(fake.of('addLabels')), ['needs-triage', 'area: conflicts']);
  const comments = fake.of('createComment');
  assert.equal(comments.length, 1);
  const body = String(comments[0]!.body);
  assert.ok(body.includes(bot.MARKER) && body.includes('@reporter') && body.includes('Output → Git Pro'));
  assert.ok(!body.includes('Some details are still empty'));
});

test('a bug report with empty required fields, or without a form, asks for details and gets needs-info', async () => {
  const empty = fakeGitHub();
  await bot.onIssueOpened({ github: empty.github, context: context('issues', { action: 'opened', issue: issue({ body: bugBody({ 'Steps to reproduce': '_No response_' }) }) }) });
  assert.ok(labelsAdded(empty.of('addLabels')).includes('needs-info'));
  assert.match(String(empty.of('createComment')[0]!.body), /Some details are still empty: Steps to reproduce/);
  const plain = fakeGitHub();
  await bot.onIssueOpened({ github: plain.github, context: context('issues', { action: 'opened', issue: issue({ body: 'It crashes', labels: [] }) }) });
  assert.ok(labelsAdded(plain.of('addLabels')).includes('needs-info'));
  assert.match(String(plain.of('createComment')[0]!.body), /not created from one of the issue forms/);
});

test('a maintainer-created issue without a form is not marked needs-info, a bot-created one is ignored, and the welcome is not repeated', async () => {
  const maintainer = fakeGitHub();
  await bot.onIssueOpened({ github: maintainer.github, context: context('issues', { action: 'opened', issue: issue({ body: 'Note to self', labels: [], author_association: 'OWNER' }) }) });
  assert.ok(!labelsAdded(maintainer.of('addLabels')).includes('needs-info'));
  const robot = fakeGitHub();
  await bot.onIssueOpened({ github: robot.github, context: context('issues', { action: 'opened', issue: issue({ user: { login: 'dependabot[bot]', type: 'Bot' } }) }) });
  assert.equal(robot.calls.length, 0);
  const again = fakeGitHub({ comments: [{ body: `${bot.MARKER}\nhello`, user: { type: 'Bot' } }] });
  await bot.onIssueOpened({ github: again.github, context: context('issues', { action: 'opened', issue: issue() }) });
  assert.equal(again.of('createComment').length, 0);
  const forged = fakeGitHub({ comments: [{ body: `${bot.MARKER}\nlook, I am the bot`, user: { type: 'User' } }] });
  await bot.onIssueOpened({ github: forged.github, context: context('issues', { action: 'opened', issue: issue() }) });
  assert.equal(forged.of('createComment').length, 1, 'only a Bot account counts as an earlier welcome');
});

test('feature requests and questions get their own tone and the matching label', async () => {
  const feature = fakeGitHub();
  await bot.onIssueOpened({ github: feature.github, context: context('issues', { action: 'opened', issue: issue({ title: 'Blame in the gutter', body: '### Problem to solve\n\nx\n\n### Proposed solution\n\ny', labels: [] }) }) });
  assert.match(String(feature.of('createComment')[0]!.body), /More detail about the situation/);
  assert.ok(labelsAdded(feature.of('addLabels')).includes('enhancement'));
  const question = fakeGitHub();
  await bot.onIssueOpened({ github: question.github, context: context('issues', { action: 'opened', issue: issue({ title: 'How do I sign commits', body: '### Your question\n\nhow?', labels: [] }) }) });
  assert.match(String(question.of('createComment')[0]!.body), /website/);
});

test('/resolve closes as completed with the version only when one is given, and clears the waiting labels', async () => {
  const fake = fakeGitHub();
  const labels = [{ name: 'bug' }, { name: 'needs-info' }, { name: 'stale' }];
  await bot.onIssueComment({ github: fake.github, context: context('issue_comment', { action: 'created', issue: issue({ labels }), comment: comment('/resolve 0.2.1', 'OWNER') }) });
  assert.ok(String(fake.of('createComment')[0]!.body).includes('Resolved in Git Pro 0.2.1'));
  assert.deepEqual(labelsAdded(fake.of('addLabels')), ['resolved']);
  assert.deepEqual(fake.of('removeLabel').map(item => item.name).sort(), ['needs-info', 'stale']);
  assert.deepEqual(fake.of('update').map(({ state, state_reason }) => ({ state, state_reason })), [{ state: 'closed', state_reason: 'completed' }]);
  const bare = fakeGitHub();
  await bot.onIssueComment({ github: bare.github, context: context('issue_comment', { action: 'created', issue: issue(), comment: comment('/resolve', 'COLLABORATOR') }) });
  assert.ok(!String(bare.of('createComment')[0]!.body).includes('Resolved in Git Pro'), 'no version is claimed unless the maintainer names one');
});

test('commands from anyone but a maintainer, on pull requests, or from bots do nothing', async () => {
  for (const [association, type, pullRequest] of [['NONE', 'User', false], ['CONTRIBUTOR', 'User', false], ['FIRST_TIME_CONTRIBUTOR', 'User', false], ['OWNER', 'Bot', false], ['OWNER', 'User', true]] as const) {
    const fake = fakeGitHub();
    await bot.onIssueComment({ github: fake.github, context: context('issue_comment', { action: 'created', issue: issue(pullRequest ? { pull_request: {} } : {}), comment: comment('/resolve 9.9.9', association, 'someone', type) }) });
    assert.equal(fake.calls.length, 0, `${association}/${type}/${pullRequest}`);
  }
  const chat = fakeGitHub();
  await bot.onIssueComment({ github: chat.github, context: context('issue_comment', { action: 'created', issue: issue(), comment: comment('Thanks, looking into it.', 'OWNER') }) });
  assert.equal(chat.calls.length, 0, 'a maintainer comment without a command is left alone');
});

test('/duplicate closes as not planned only when the other issue exists', async () => {
  const found = fakeGitHub({ issues: [7] });
  await bot.onIssueComment({ github: found.github, context: context('issue_comment', { action: 'created', issue: issue(), comment: comment('/duplicate #7', 'OWNER') }) });
  assert.deepEqual(labelsAdded(found.of('addLabels')), ['duplicate']);
  assert.deepEqual(found.of('update').map(item => item.state_reason), ['not_planned']);
  const missing = fakeGitHub({ issues: [7] });
  await bot.onIssueComment({ github: missing.github, context: context('issue_comment', { action: 'created', issue: issue(), comment: comment('/duplicate #9', 'OWNER') }) });
  assert.equal(missing.of('update').length, 0);
  assert.match(String(missing.of('createComment')[0]!.body), /#9 was not found/);
  const self = fakeGitHub({ issues: [12] });
  await bot.onIssueComment({ github: self.github, context: context('issue_comment', { action: 'created', issue: issue(), comment: comment('/duplicate #12', 'OWNER') }) });
  assert.equal(self.of('update').length, 0);
});

test('/needs-info, /triaged, /reopen, /label and /unlabel stay inside their limits', async () => {
  const info = fakeGitHub();
  await bot.onIssueComment({ github: info.github, context: context('issue_comment', { action: 'created', issue: issue({ labels: [{ name: 'needs-triage' }] }), comment: comment('/needs-info cc @everyone please share the output', 'OWNER') }) });
  assert.ok(labelsAdded(info.of('addLabels')).includes('needs-info'));
  assert.deepEqual(info.of('removeLabel').map(item => item.name), ['needs-triage']);
  const body = String(info.of('createComment')[0]!.body);
  assert.ok(body.includes('14 days') && !body.includes('@everyone') && body.includes('@​everyone'), 'a note never pings anybody');
  const triaged = fakeGitHub();
  await bot.onIssueComment({ github: triaged.github, context: context('issue_comment', { action: 'created', issue: issue({ labels: [{ name: 'needs-triage' }] }), comment: comment('/triaged', 'OWNER') }) });
  assert.deepEqual(triaged.of('removeLabel').map(item => item.name), ['needs-triage']);
  const reopen = fakeGitHub();
  await bot.onIssueComment({ github: reopen.github, context: context('issue_comment', { action: 'created', issue: issue({ state: 'closed' }), comment: comment('/reopen', 'OWNER') }) });
  assert.deepEqual(reopen.of('update').map(({ state, state_reason }) => ({ state, state_reason })), [{ state: 'open', state_reason: 'reopened' }]);
  const open = fakeGitHub();
  await bot.onIssueComment({ github: open.github, context: context('issue_comment', { action: 'created', issue: issue(), comment: comment('/reopen', 'OWNER') }) });
  assert.equal(open.of('update').length, 0, 'an open issue is not reopened');
  const label = fakeGitHub({ labels: ['bug', 'wontfix'] });
  await bot.onIssueComment({ github: label.github, context: context('issue_comment', { action: 'created', issue: issue({ labels: [{ name: 'bug' }, { name: 'wontfix' }] }), comment: comment('/label wontfix, invented-label', 'OWNER') }) });
  assert.deepEqual(labelsAdded(label.of('addLabels')), ['wontfix'], 'only labels that already exist can be added');
  assert.equal(label.of('createLabel').length, 0);
  await bot.onIssueComment({ github: label.github, context: context('issue_comment', { action: 'created', issue: issue({ labels: [{ name: 'bug' }, { name: 'wontfix' }] }), comment: comment('/unlabel wontfix', 'OWNER') }) });
  assert.deepEqual(label.of('removeLabel').map(item => item.name), ['wontfix']);
});

test('a reply from the reporter puts a needs-info issue back in the triage queue, and closing clears the waiting labels', async () => {
  const fake = fakeGitHub();
  await bot.onIssueComment({ github: fake.github, context: context('issue_comment', { action: 'created', issue: issue({ labels: [{ name: 'bug' }, { name: 'needs-info' }, { name: 'stale' }] }), comment: comment('Here is the output.', 'NONE', 'reporter') }) });
  assert.deepEqual(fake.of('removeLabel').map(item => item.name).sort(), ['needs-info', 'stale']);
  assert.ok(labelsAdded(fake.of('addLabels')).includes('needs-triage'));
  const other = fakeGitHub();
  await bot.onIssueComment({ github: other.github, context: context('issue_comment', { action: 'created', issue: issue({ labels: [{ name: 'needs-info' }] }), comment: comment('Same here.', 'NONE', 'someone-else') }) });
  assert.equal(other.calls.length, 0, 'only the reporter answers a request for information');
  const closed = fakeGitHub();
  await bot.onIssueClosed({ github: closed.github, context: context('issues', { action: 'closed', issue: issue({ labels: [{ name: 'bug' }, { name: 'needs-triage' }, { name: 'stale' }] }) }) });
  assert.deepEqual(closed.of('removeLabel').map(item => item.name).sort(), ['needs-triage', 'stale']);
});

test('the issue forms use the headings the bot reads', () => {
  const read = (name: string) => readFileSync(path.resolve('.github', 'ISSUE_TEMPLATE', name), 'utf8');
  const bug = read('bug_report.yml'), feature = read('feature_request.yml'), question = read('question.yml');
  for (const key of ['version', 'vscode', 'os', 'git', 'workspace', 'steps', 'expected', 'actual', 'logs']) assert.ok(bug.includes(`label: ${bot.HEADINGS[key]}\n`), `bug_report.yml needs "${bot.HEADINGS[key]}"`);
  for (const key of ['problem', 'proposal']) assert.ok(feature.includes(`label: ${bot.HEADINGS[key]}\n`), `feature_request.yml needs "${bot.HEADINGS[key]}"`);
  assert.ok(question.includes(`label: ${bot.HEADINGS.question}\n`));
  assert.match(read('config.yml'), /blank_issues_enabled: false/);
  for (const [name, text] of [['bug_report.yml', bug], ['feature_request.yml', feature], ['question.yml', question]]) assert.match(text!, /^labels: \[[a-z]+\]$/m, `${name} sets its type label`);
});

test('workflows never expand issue or comment text, declare permissions, and pin actions to a major version', () => {
  const directory = path.resolve('.github', 'workflows');
  for (const name of readdirSync(directory).filter(item => item.endsWith('.yml'))) {
    const text = readFileSync(path.join(directory, name), 'utf8');
    assert.match(text, /^permissions:/m, `${name} declares permissions`);
    assert.doesNotMatch(text, /\$\{\{\s*github\.event\.(issue|comment|pull_request)\.(title|body)/, `${name} must not interpolate user text`);
    assert.doesNotMatch(text, /\$\{\{\s*github\.event\.comment\.body/, `${name} must not interpolate comment text`);
    for (const match of text.matchAll(/uses:\s*([\w./-]+)@(\S+)/g)) assert.match(match[2]!, /^v\d+(\.\d+)*$/, `${name}: ${match[1]} is pinned to a version tag`);
  }
  const botWorkflow = readFileSync(path.join(directory, 'issue-bot.yml'), 'utf8');
  assert.match(botWorkflow, /github\.repository == 'nhech\/git-pro'/);
  assert.match(botWorkflow, /persist-credentials: false/);
  assert.doesNotMatch(botWorkflow, /pull_request_target/, 'the bot never runs code from a pull request');
});
