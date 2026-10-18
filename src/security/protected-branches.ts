/**
 * The branches a user asked to be asked about before a commit, a push, a force push or a delete: the glob patterns of `gitPro.protectedBranches`. `*` matches within one
 * path segment (`release/*` is `release/1.1` but not `release/1/2`), `**` matches across segments, `?` is one character. No `vscode` import: unit tests load this module as it is.
 */
const MAX_PATTERNS = 100, MAX_PATTERN_LENGTH = 200;

/** The patterns of a setting value: only text, trimmed, without empty entries or entries that are too long. */
export function protectedBranchPatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim().replace(/^refs\/heads\//, '')).filter(entry => entry.length > 0 && entry.length <= MAX_PATTERN_LENGTH).slice(0, MAX_PATTERNS);
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === '*') { if (pattern[index + 1] === '*') { source += '.*'; index++; } else source += '[^/]*'; }
    else if (character === '?') source += '[^/]';
    else source += character.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** Whether a branch name (or a `refs/heads/…` ref) is one of the protected patterns. A detached HEAD or no branch is never protected. */
export function isProtectedBranch(branch: string | undefined, value: unknown): boolean {
  if (!branch || branch === '(detached)') return false;
  const name = branch.replace(/^refs\/heads\//, '');
  return protectedBranchPatterns(value).some(pattern => globToRegExp(pattern).test(name));
}
