// Logic of the issue bot (.github/workflows/issue-bot.yml), loaded by actions/github-script. The pure helpers are
// exported for test/unit/issue-bot.test.ts. Issue and comment text is data only: it never reaches a shell, labels
// come from a fixed list or from labels that already exist, and only maintainers can run commands.
'use strict';

const REPO_URL = 'https://github.com/nhech/git-pro';
const LIMITS_URL = `${REPO_URL}/blob/main/docs/user-guide/RELEASE_STATUS.md`;
const SITE_URL = 'https://git-pro.longtd.me/';
const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const MARKER = '<!-- git-pro-bot -->';
const FOOTER = '_This is an automated message from the repository issue bot._';

/** Labels the bot manages; it creates the missing ones and never touches the rest. */
const LABELS = {
  'needs-triage': { color: 'fbca04', description: 'A maintainer has not looked at this yet' },
  'needs-info': { color: 'd93f0b', description: 'Waiting for more information from the reporter' },
  stale: { color: 'cccccc', description: 'No reply after a request for information' },
  resolved: { color: '0e8a16', description: 'Fixed or answered' },
  'area: changes': { color: 'c5def5', description: 'Changes view, staging and discard' },
  'area: commit': { color: 'c5def5', description: 'Commit box, amend, sign-off and signing' },
  'area: history': { color: 'c5def5', description: 'History, File History, blame and CodeLens' },
  'area: compare': { color: 'c5def5', description: 'Compare tab and Get from Branch' },
  'area: conflicts': { color: 'c5def5', description: 'Conflicts tab and merge editor' },
  'area: advanced': { color: 'c5def5', description: 'Merge, rebase, cherry-pick, revert and reset' },
  'area: tools': { color: 'c5def5', description: 'Stashes, tags, remotes and worktrees' },
  'area: branches': { color: 'c5def5', description: 'Branches, fetch, pull and push' },
};
const STATE_LABELS = ['needs-triage', 'needs-info', 'stale'];

/** First match wins and at most two areas are added, so a long report does not collect every label. */
const AREAS = [
  ['area: conflicts', /\b(conflicts?|merge editor|accept (yours|theirs))\b/i],
  ['area: compare', /\b(compare|comparison|get from branch|diff with)\b/i],
  ['area: commit', /\b(commit box|commit composer|amend|sign-?off|commit message|gpg|signing)\b/i],
  ['area: advanced', /\b(rebase|cherry-?pick|revert|reset|merge into)\b/i],
  ['area: history', /\b(history|graph|blame|codelens)\b/i],
  ['area: tools', /\b(stash(es)?|tags?|remotes?|worktrees?)\b/i],
  ['area: changes', /\b(changes view|stage[sd]?|unstage|discard|untracked)\b/i],
  ['area: branches', /\b(branch(es)?|checkout|upstream|fetch|pull|push)\b/i],
];

/** Headings of the issue forms in .github/ISSUE_TEMPLATE; a test keeps them in sync. */
const HEADINGS = {
  version: 'Git Pro version', vscode: 'VS Code version', os: 'Operating system', git: 'Git version', workspace: 'Where is the workspace?',
  steps: 'Steps to reproduce', expected: 'Expected behavior', actual: 'Actual behavior', logs: 'Git Pro output',
  problem: 'Problem to solve', proposal: 'Proposed solution', question: 'Your question',
};
const REQUIRED_BUG_FIELDS = ['version', 'vscode', 'os', 'steps', 'actual'];

/** Splits an issue-form body ("### Heading" sections) into a map; "_No response_" and blanks become empty strings. */
function parseForm(body) {
  const sections = {};
  const text = String(body || '').replace(/\r\n/g, '\n');
  const parts = text.split(/^### +(.+?) *$/m);
  for (let index = 1; index < parts.length; index += 2) {
    const value = String(parts[index + 1] || '').trim();
    sections[parts[index].trim()] = /^_?no response_?$/i.test(value) ? '' : value;
  }
  return sections;
}

/** 'bug', 'enhancement', 'question' or undefined, from the form headings (not from free text). */
function issueType(sections) {
  if (HEADINGS.steps in sections) return 'bug';
  if (HEADINGS.proposal in sections) return 'enhancement';
  if (HEADINGS.question in sections) return 'question';
  return undefined;
}

function missingBugFields(sections) {
  return REQUIRED_BUG_FIELDS.filter(key => !(sections[HEADINGS[key]] || '').trim());
}

/** The text areas are guessed from: only what the reporter wrote, not the form's dropdown values (an SSH workspace is not a remote tool). */
function areaText(sections, body) {
  if (Object.keys(sections).length === 0) return body || '';
  return ['steps', 'expected', 'actual', 'problem', 'proposal', 'question'].map(key => sections[HEADINGS[key]] || '').join('\n');
}

function areaLabels(title, body) {
  const text = `${title || ''}\n${body || ''}`;
  return AREAS.filter(([, pattern]) => pattern.test(text)).slice(0, 2).map(([label]) => label);
}

/** A slash command on the first non-empty line that is not quoted; text after the arguments is ignored. */
function parseCommand(body) {
  const line = String(body || '').split(/\r?\n/).map(item => item.trim()).find(item => item.length > 0);
  if (!line || !line.startsWith('/')) return undefined;
  const match = /^\/([a-z-]+)(?:\s+(.*))?$/i.exec(line);
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  const rest = (match[2] || '').trim();
  switch (name) {
    case 'resolve': {
      if (!rest) return { name };
      const version = /^v?(\d+\.\d+\.\d+)$/.exec(rest);
      return version ? { name, version: version[1] } : undefined;
    }
    case 'duplicate': {
      const number = /^#?(\d{1,7})$/.exec(rest);
      return number ? { name, number: Number(number[1]) } : undefined;
    }
    case 'needs-info': return { name, note: rest.slice(0, 500) };
    case 'triaged': case 'reopen': return rest ? undefined : { name };
    case 'label': case 'unlabel': {
      const labels = rest.split(',').map(item => item.trim()).filter(Boolean);
      return labels.length > 0 && labels.length <= 5 && labels.every(item => /^[\w .:&-]{1,50}$/.test(item)) ? { name, labels } : undefined;
    }
    default: return undefined;
  }
}

function welcomeComment({ login, type, missing, hasForm }) {
  const lines = [MARKER, `Thanks for opening this, @${login}. A maintainer will take a look.`, ''];
  if (!hasForm) {
    lines.push('This issue was not created from one of the issue forms, so it may be missing details. Please add:', '- the Git Pro version and the VS Code version',
      '- your operating system and how the workspace is opened (local folder, WSL, SSH, Dev Container)', '- the steps that lead to the problem, and what you expected to happen', '');
  } else if (type === 'bug' && missing.length > 0) {
    lines.push(`Some details are still empty: ${missing.map(key => HEADINGS[key]).join(', ')}. Please add them so the problem can be reproduced.`, '');
  }
  if (type === 'bug' || type === undefined) {
    lines.push('While you wait:', `- Check [Compatibility and limitations](${LIMITS_URL}) for known limits (for example, Remote WSL and Dev Containers have not finished validation).`,
      '- If you can, attach the Git Pro output (**View → Output → Git Pro**). Git Pro redacts credentials, but please review it before posting.', '');
  } else if (type === 'question') {
    lines.push(`The [website](${SITE_URL}) and the [documentation](${REPO_URL}/tree/main/docs/user-guide) may already answer this.`, '');
  } else {
    lines.push('More detail about the situation that led to this request helps with prioritising it.', '');
  }
  lines.push(FOOTER);
  return lines.join('\n');
}

function resolveComment(version) {
  return [MARKER, version ? `Resolved in Git Pro ${version}. Update from the Extensions view; if it still happens after updating, reply here and a maintainer can reopen this.`
    : 'Resolved. The fix will be in the next published version. If it still happens after updating, reply here and a maintainer can reopen this.', '', FOOTER].join('\n');
}

const isMaintainer = association => MAINTAINER_ASSOCIATIONS.has(String(association || ''));
const issueRef = context => ({ owner: context.repo.owner, repo: context.repo.repo, issue_number: context.payload.issue.number });
const labelNames = issue => (issue.labels || []).map(label => (typeof label === 'string' ? label : label.name));

async function ensureLabels(github, context, names) {
  const existing = new Set((await github.rest.issues.listLabelsForRepo({ owner: context.repo.owner, repo: context.repo.repo, per_page: 100 })).data.map(label => label.name));
  for (const name of names) {
    if (existing.has(name) || !LABELS[name]) continue;
    try { await github.rest.issues.createLabel({ owner: context.repo.owner, repo: context.repo.repo, name, ...LABELS[name] }); } catch (error) { if (error.status !== 422) throw error; }
  }
  return existing;
}

async function hasBotComment(github, context) {
  const comments = await github.rest.issues.listComments({ ...issueRef(context), per_page: 100 });
  return comments.data.some(comment => String(comment.body || '').includes(MARKER) && comment.user && comment.user.type === 'Bot');
}

async function removeLabels(github, context, names) {
  const present = new Set(labelNames(context.payload.issue));
  for (const name of names.filter(item => present.has(item))) {
    try { await github.rest.issues.removeLabel({ ...issueRef(context), name }); } catch (error) { if (error.status !== 404) throw error; }
  }
}

async function onIssueOpened({ github, context }) {
  const issue = context.payload.issue;
  if (issue.user && issue.user.type === 'Bot') return;
  const sections = parseForm(issue.body);
  const hasForm = Object.keys(sections).length > 0;
  const type = issueType(sections);
  const missing = type === 'bug' ? missingBugFields(sections) : [];
  const needsInfo = !isMaintainer(issue.author_association) && (!hasForm || missing.length > 0);
  const labels = ['needs-triage', ...areaLabels(issue.title, areaText(sections, issue.body)), ...(needsInfo ? ['needs-info'] : [])];
  const existing = await ensureLabels(github, context, labels);
  const typeLabel = type === 'bug' ? 'bug' : type === 'enhancement' ? 'enhancement' : type === 'question' ? 'question' : undefined;
  const add = [...labels, ...(typeLabel && existing.has(typeLabel) && !labelNames(issue).includes(typeLabel) ? [typeLabel] : [])];
  await github.rest.issues.addLabels({ ...issueRef(context), labels: add });
  if (!(await hasBotComment(github, context))) {
    await github.rest.issues.createComment({ ...issueRef(context), body: welcomeComment({ login: issue.user.login, type, missing, hasForm }) });
  }
}

async function react(github, context, content) {
  try { await github.rest.reactions.createForIssueComment({ owner: context.repo.owner, repo: context.repo.repo, comment_id: context.payload.comment.id, content }); } catch { /* a missing reaction is harmless */ }
}

async function runCommand({ github, context }, command) {
  const issue = context.payload.issue;
  const ref = issueRef(context);
  switch (command.name) {
    case 'resolve': {
      await ensureLabels(github, context, ['resolved']);
      await github.rest.issues.addLabels({ ...ref, labels: ['resolved'] });
      await removeLabels(github, context, STATE_LABELS);
      await github.rest.issues.createComment({ ...ref, body: resolveComment(command.version) });
      await github.rest.issues.update({ ...ref, state: 'closed', state_reason: 'completed' });
      return;
    }
    case 'duplicate': {
      if (command.number === issue.number) { await github.rest.issues.createComment({ ...ref, body: `${MARKER}\nAn issue cannot be a duplicate of itself.\n\n${FOOTER}` }); return; }
      try { await github.rest.issues.get({ owner: context.repo.owner, repo: context.repo.repo, issue_number: command.number }); } catch (error) {
        if (error.status !== 404) throw error;
        await github.rest.issues.createComment({ ...ref, body: `${MARKER}\nIssue #${command.number} was not found.\n\n${FOOTER}` }); return;
      }
      await github.rest.issues.addLabels({ ...ref, labels: ['duplicate'] });
      await removeLabels(github, context, STATE_LABELS);
      await github.rest.issues.createComment({ ...ref, body: `${MARKER}\nClosing as a duplicate of #${command.number}. Please continue the discussion there.\n\n${FOOTER}` });
      await github.rest.issues.update({ ...ref, state: 'closed', state_reason: 'not_planned' });
      return;
    }
    case 'needs-info': {
      await ensureLabels(github, context, ['needs-info']);
      await github.rest.issues.addLabels({ ...ref, labels: ['needs-info'] });
      await removeLabels(github, context, ['needs-triage']);
      const note = command.note ? `\n\n${command.note.replace(/@/g, '@​')}` : '';
      await github.rest.issues.createComment({ ...ref, body: `${MARKER}\nMore information is needed to look into this. If there is no reply in 21 days, this issue will be closed automatically; it can be reopened when the details are available.${note}\n\n${FOOTER}` });
      return;
    }
    case 'triaged': await removeLabels(github, context, ['needs-triage']); return;
    case 'reopen': if (issue.state === 'closed') await github.rest.issues.update({ ...ref, state: 'open', state_reason: 'reopened' }); return;
    case 'label': case 'unlabel': {
      const existing = await ensureLabels(github, context, []);
      const known = command.labels.filter(name => existing.has(name));
      if (known.length === 0) return;
      if (command.name === 'label') await github.rest.issues.addLabels({ ...ref, labels: known });
      else await removeLabels(github, context, known);
      return;
    }
    default:
  }
}

async function onIssueComment({ github, context }) {
  const issue = context.payload.issue;
  const comment = context.payload.comment;
  if (issue.pull_request || !comment || (comment.user && comment.user.type === 'Bot')) return;
  if (isMaintainer(comment.author_association)) {
    const command = parseCommand(comment.body);
    if (command) { await react(github, context, 'eyes'); await runCommand({ github, context }, command); await react(github, context, '+1'); }
    return;
  }
  // The reporter answered a request for information: it is ready for another look.
  if (issue.state !== 'closed' && issue.user && comment.user && issue.user.login === comment.user.login && labelNames(issue).includes('needs-info')) {
    await ensureLabels(github, context, ['needs-triage']);
    await removeLabels(github, context, ['needs-info', 'stale']);
    await github.rest.issues.addLabels({ ...issueRef(context), labels: ['needs-triage'] });
  }
}

async function onIssueClosed({ github, context }) {
  await removeLabels(github, context, STATE_LABELS);
}

async function run({ github, context }) {
  if (context.eventName === 'issues' && context.payload.action === 'opened') return onIssueOpened({ github, context });
  if (context.eventName === 'issues' && context.payload.action === 'closed') return onIssueClosed({ github, context });
  if (context.eventName === 'issue_comment' && context.payload.action === 'created') return onIssueComment({ github, context });
}

module.exports = { run, onIssueOpened, onIssueComment, onIssueClosed, parseForm, parseCommand, issueType, missingBugFields, areaLabels, areaText, welcomeComment, isMaintainer, HEADINGS, LABELS, MARKER };
