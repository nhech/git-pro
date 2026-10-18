/**
 * Where a repository lives on the web, built from the address of its remote and nothing else: no request is made, no account is read. A commit, an issue or a pull request
 * becomes a link that the user opens on purpose. GitHub, GitLab, Bitbucket and Codeberg are known; another host (a company server) is named in the setting
 * `gitPro.remoteHosts`. No `vscode` import: unit tests load this module as it is.
 */
export type HostKind = 'github' | 'gitlab' | 'bitbucket' | 'gitea';
export interface RemoteWeb { readonly kind: HostKind; /** `https://host/owner/repo`, without credentials, a port that belongs to SSH, or `.git`. */ readonly base: string }

const knownHosts: Readonly<Record<string, HostKind>> = { 'github.com': 'github', 'gitlab.com': 'gitlab', 'bitbucket.org': 'bitbucket', 'codeberg.org': 'gitea' };
const kinds: ReadonlySet<string> = new Set(['github', 'gitlab', 'bitbucket', 'gitea']);
const hostPattern = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/, segmentPattern = /^[A-Za-z0-9._-]{1,100}$/;

/** The hosts of the setting: lower-case names with a known kind, and nothing else. */
export function remoteHostMap(value: unknown): Record<string, HostKind> {
  const result: Record<string, HostKind> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [host, kind] of Object.entries(value as Record<string, unknown>).slice(0, 50)) { const name = host.trim().toLowerCase(); if (hostPattern.test(name) && typeof kind === 'string' && kinds.has(kind)) result[name] = kind as HostKind; }
  return result;
}

/** The web address of a remote: its `https://`, `http://`, `ssh://`, `git://` or `user@host:path` form, when its host is known or named in `hosts`. */
export function parseRemoteUrl(url: string, hosts: unknown = {}): RemoteWeb | undefined {
  const text = url.trim();
  if (!text || text.length > 2048 || /[\s\0]/.test(text)) return undefined;
  let scheme = 'https', host: string, rawPath: string, port = '';
  const standard = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::(\d{1,5}))?\/(.+)$/i.exec(text);
  if (standard) {
    const protocol = standard[1]!.toLowerCase();
    if (!['https', 'http', 'ssh', 'git'].includes(protocol)) return undefined;
    scheme = protocol === 'http' ? 'http' : 'https'; host = standard[2]!.toLowerCase(); port = protocol === 'https' || protocol === 'http' ? standard[3] ?? '' : ''; rawPath = standard[4]!;
  } else {
    const scp = /^(?:[^@/:\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text);
    if (!scp) return undefined;
    host = scp[1]!.toLowerCase(); rawPath = scp[2]!;
  }
  if (!hostPattern.test(host)) return undefined;
  const kind = remoteHostMap(hosts)[host] ?? knownHosts[host];
  if (!kind) return undefined;
  const segments = rawPath.replace(/[?#].*$/, '').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '').split('/');
  if (segments.length < 2 || (kind !== 'gitlab' && segments.length !== 2) || segments.some(segment => !segmentPattern.test(segment) || segment === '.' || segment === '..')) return undefined;
  return { kind, base: `${scheme}://${host}${port ? `:${port}` : ''}/${segments.join('/')}` };
}

/** The page of a commit. The object name must be a full or abbreviated hash. */
export function commitUrl(web: RemoteWeb, oid: string): string | undefined {
  if (!/^[0-9a-f]{7,64}$/i.test(oid)) return undefined;
  const hash = oid.toLowerCase();
  return web.kind === 'gitlab' ? `${web.base}/-/commit/${hash}` : web.kind === 'bitbucket' ? `${web.base}/commits/${hash}` : `${web.base}/commit/${hash}`;
}

/** The page of an issue (`#12`) or, on GitLab, a merge request (`!12`). GitHub shows a pull request at its issue address. */
export function referenceUrl(web: RemoteWeb, prefix: string, number: number): string | undefined {
  if (!Number.isInteger(number) || number < 1 || number > 9_999_999) return undefined;
  if (prefix === '!') return web.kind === 'gitlab' ? `${web.base}/-/merge_requests/${number}` : undefined;
  if (prefix !== '#') return undefined;
  return web.kind === 'gitlab' ? `${web.base}/-/issues/${number}` : `${web.base}/issues/${number}`;
}

export interface Reference { readonly start: number; readonly end: number; readonly prefix: '#' | '!'; readonly number: number }

/** The `#123` and `!123` references in a commit message, at most 50, in order. A reference is not part of a word, a path, a URL or an HTML entity. */
export function findReferences(message: string): Reference[] {
  const result: Reference[] = [];
  for (const match of message.matchAll(/(?<![\w/#&!.-])([#!])(\d{1,7})(?![\w-])/g)) {
    result.push({ start: match.index, end: match.index + match[0].length, prefix: match[1] as '#' | '!', number: Number(match[2]) });
    if (result.length >= 50) break;
  }
  return result;
}
