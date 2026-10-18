import type { RemoteWeb } from './remote-link';

/**
 * Pull requests without an account or an HTTP client: GitHub, GitLab, Gitea/Forgejo and Bitbucket Server publish each pull request as a ref of the repository itself
 * (`refs/pull/123/head`), so `git fetch` brings it in with the credentials the built-in Git already has. The ref is kept under `refs/gitpro/pr/<remote>/<number>`,
 * which no branch list shows, and is replaced by the next fetch of the same pull request. Nothing here reads the host's pages or API.
 * No `vscode` import: unit tests load this module as it is.
 */
const maximum = 9_999_999;

/** What the host calls it: GitLab has merge requests, the others pull requests. */
export function pullRequestNoun(web: RemoteWeb): 'pull request' | 'merge request' { return web.kind === 'gitlab' ? 'merge request' : 'pull request'; }

/** The ref the host publishes for the head of pull request `number`, or undefined when the host publishes none (Bitbucket Cloud) or the number is not one. */
export function pullRequestSource(web: RemoteWeb, number: number): string | undefined {
  if (!Number.isInteger(number) || number < 1 || number > maximum) return undefined;
  switch (web.kind) {
    case 'github': case 'gitea': return `refs/pull/${number}/head`;
    case 'gitlab': return `refs/merge-requests/${number}/head`;
    // Bitbucket Cloud has no such refs; a Bitbucket Server or Data Center named in `gitPro.remoteHosts` does.
    case 'bitbucket': return hostOf(web) === 'bitbucket.org' ? undefined : `refs/pull-requests/${number}/from`;
  }
}

/** Where Git Pro keeps a fetched pull request. `remote` must already be a valid remote name. */
export function pullRequestRef(remote: string, number: number): string {
  // Each part of the remote's name is a plain ref component: it starts with a letter, digit or underscore, has no `..`, and does not end with `.` or `.lock`.
  const plain = remote.split('/').every(part => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(part) && !part.includes('..') && !part.endsWith('.') && !part.endsWith('.lock'));
  if (!plain || !Number.isInteger(number) || number < 1 || number > maximum) throw new Error('Invalid pull request ref.');
  return `refs/gitpro/pr/${remote}/${number}`;
}

/** The refspec that fetches the pull request into its ref, forced so a pull request that was pushed over is replaced. */
export function pullRequestRefspec(web: RemoteWeb, remote: string, number: number): string | undefined {
  const source = pullRequestSource(web, number);
  return source ? `+${source}:${pullRequestRef(remote, number)}` : undefined;
}

/** How a Compare tab names a fetched pull request: `PR #123` (`origin` is the remote it came from). */
export function pullRequestLabel(ref: string): string | undefined {
  const match = /^refs\/gitpro\/pr\/(?:[A-Za-z0-9._-]+\/)+([1-9]\d{0,6})$/.exec(ref);
  return match ? `PR #${match[1]}` : undefined;
}

const hostOf = (web: RemoteWeb) => { try { return new URL(web.base).hostname; } catch { return ''; } };

/**
 * The number typed for a pull request: `123`, `#123`, `!123`, or the link to it. A link must be for this repository, so a pull request of another one is not fetched from this
 * remote under the wrong number. Returns the number, or the reason it cannot be used.
 */
export function parsePullRequestInput(input: string, web: RemoteWeb): { readonly number: number } | { readonly error: string } {
  const text = input.trim(), noun = pullRequestNoun(web);
  if (!text) return { error: `Enter the number of the ${noun}.` };
  const plain = /^[#!]?(\d{1,7})$/.exec(text);
  if (plain) { const number = Number(plain[1]); return number >= 1 ? { number } : { error: `A ${noun} number starts at 1.` }; }
  let url: URL;
  try { url = new URL(text); } catch { return { error: `Enter a number such as 123, or the link to the ${noun}.` }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: `Enter a number such as 123, or the link to the ${noun}.` };
  const base = new URL(web.base), path = url.pathname.replace(/\/+$/, '');
  const match = /^(.*?)\/(?:-\/)?(?:pull|pulls|pull-requests|merge_requests)\/(\d{1,7})(?:\/.*)?$/.exec(path);
  if (!match) return { error: `That link is not the link of a ${noun}.` };
  // A Bitbucket Server link is /projects/KEY/repos/name/…, which is not the path its clone address has, so only its host can be compared.
  const sameRepository = web.kind === 'bitbucket' || match[1]!.toLowerCase() === base.pathname.toLowerCase().replace(/\/+$/, '');
  if (url.host.toLowerCase() !== base.host || !sameRepository) return { error: `That link is for another repository than this remote's (${base.host}${base.pathname}).` };
  const number = Number(match[2]);
  return number >= 1 ? { number } : { error: `A ${noun} number starts at 1.` };
}
