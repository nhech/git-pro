import { commitUrl, parseRemoteUrl, referenceUrl, type RemoteWeb } from './remote-link';

/** What the links need from the repository: its remotes with their fetch URLs, the remote its branch follows, and the hosts the user named. */
export interface RemoteSource {
  remotes(repositoryId: string): Promise<readonly { readonly name: string; readonly fetch: readonly string[] }[]>;
  /** The upstream of the current branch, `origin/main`. */
  upstream(repositoryId: string): string | undefined;
  hosts(repositoryId: string): unknown;
}

/** The remote that links and fetched pull requests are for, and where it lives on the web. */
export interface RemoteTarget { readonly remote: string; readonly web: RemoteWeb }

/** The text for when a link cannot be made. */
export const remoteLinkHelp = 'This repository\'s remote is not on GitHub, GitLab, Bitbucket or Codeberg. Name its host in the setting gitPro.remoteHosts (for example { "git.example.com": "gitlab" }).';

/**
 * The web pages of the repository's remote, for Open on Remote and the `#123` links of History. The remote is the one the current branch follows, else `origin`, else the only one.
 * Reading it costs a few Git reads, so the answer is kept for half a minute. Nothing here fails the caller: a repository without a usable remote simply has no links.
 */
export class RemoteLinks {
  private readonly cache = new Map<string, { readonly at: number; readonly value: Promise<RemoteTarget | undefined> }>();
  constructor(private readonly source: RemoteSource, private readonly now: () => number = Date.now) {}
  readonly help = remoteLinkHelp;
  async web(repositoryId: string): Promise<RemoteWeb | undefined> { return (await this.target(repositoryId))?.web; }
  /** The remote the links are for, with its web address. */
  target(repositoryId: string): Promise<RemoteTarget | undefined> {
    const key = `${repositoryId}\0${this.source.upstream(repositoryId) ?? ''}`, cached = this.cache.get(key);
    if (cached && this.now() - cached.at < 30_000) return cached.value;
    const value = this.read(repositoryId);
    this.cache.set(key, { at: this.now(), value });
    if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }
  private async read(repositoryId: string): Promise<RemoteTarget | undefined> {
    try {
      const remotes = await this.source.remotes(repositoryId); if (!remotes.length) return undefined;
      const upstream = this.source.upstream(repositoryId);
      const followed = upstream ? [...remotes].sort((a, b) => b.name.length - a.name.length).find(remote => upstream.startsWith(`${remote.name}/`)) : undefined;
      const remote = followed ?? remotes.find(item => item.name === 'origin') ?? (remotes.length === 1 ? remotes[0] : undefined);
      const url = remote?.fetch[0], web = url ? parseRemoteUrl(url, this.source.hosts(repositoryId)) : undefined; return remote && web ? { remote: remote.name, web } : undefined;
    } catch { return undefined; }
  }
  /** What History may offer: the prefixes of references (`#`, and `!` on GitLab) that have a page. Undefined when the remote has no web address. */
  async pages(repositoryId: string): Promise<{ readonly prefixes: string } | undefined> { const web = await this.web(repositoryId); return web ? { prefixes: referenceUrl(web, '!', 1) ? '#!' : '#' } : undefined; }
  async commit(repositoryId: string, oid: string): Promise<string | undefined> { const web = await this.web(repositoryId); return web ? commitUrl(web, oid) : undefined; }
  async reference(repositoryId: string, prefix: string, number: number): Promise<string | undefined> { const web = await this.web(repositoryId); return web ? referenceUrl(web, prefix, number) : undefined; }
}
