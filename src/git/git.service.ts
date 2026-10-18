import { createHash } from 'node:crypto';
import { lstat, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { GitExecutor } from './git-executor';
import type { DailyBackend, CommitRequest, RemoteInfo } from './daily-backend';
import { hasChanges, parseStatus, stagedFingerprint, type StatusSnapshot } from './git-parser';
import { PathPolicy, containsPath } from '../security/paths';
import { validateBranchName, validateOid } from '../security/refs';
import type { RestoreFromSource } from '../webviews/compare/compare-contract';
import { RepositoryRegistry, type RepositoryDescriptor } from '../repositories/repository-registry';
import { OperationCoordinator } from '../state/operation-coordinator';
import { detectOperation, gitPseudoRefs } from '../state/operation-state';
import { recoveryFor } from '../utils/recovery';
import { partiallyApplied } from './git-error-parser';
import { displayBranchOutput } from './branch-display';
import { Emitter } from '../utils/events';
import { chunkPaths } from './argv-chunks';
import { parseIndex } from './conflicts/index-parser';
import { pullRequestRef, pullRequestRefspec } from './pull-request';
import type { RemoteWeb } from './remote-link';

interface Ready { repo: RepositoryDescriptor; status: StatusSnapshot; raw: Buffer }
export interface DailyPreview { repositoryId: string; head: string | undefined; refs: string; index: string; working: string; paths: readonly string[]; status: StatusSnapshot }
export interface BranchInfo { name: string; ref: string; oid: string; remote: boolean; upstream: string; worktree: string }
export class DailyError extends Error {
  constructor(readonly code: 'dirty' | 'no-upstream' | 'detached' | 'stale' | 'operation' | 'empty-index' | 'publish' | 'conflict' | 'diverged', message: string) { super(message); }
}
export interface CommitResult { oid: string; pushed: boolean; pushError?: string }
/**
 * A working-tree "added" entry is an intent-to-add file (`git add -N`): tracked by name, with no content in the index. Paired with a file deleted from
 * disk, status reports the same entry as the target of a working-tree rename (or copy) instead: only such a placeholder can be added in the working tree.
 */
export function isIntentToAdd(change: { readonly group: string; readonly status: string }): boolean { return change.group === 'working' && (change.status === 'A' || change.status === 'R' || change.status === 'C'); }
/** The given paths that status reports as intent-to-add, in their order. */
export function intentToAdd(status: StatusSnapshot, paths: readonly string[]): string[] {
  const placeholders = new Set(status.changes.filter(isIntentToAdd).map(change => change.path));
  return paths.filter(file => placeholders.has(file));
}
/** Runs an action per group of at most 5000 paths, the per-call bound. Staging and unstaging are reversible, so a later group failing leaves a reviewable state that the error describes. */
async function inGroups(paths: readonly string[], action: (group: readonly string[]) => Promise<void>): Promise<void> {
  const total = Math.ceil(paths.length / 5000);
  for (let index = 0; index < total; index++) {
    try { await action(paths.slice(index * 5000, (index + 1) * 5000)); }
    catch (error) { throw index ? partiallyApplied(error, index, total) : error; }
  }
}
export class GitService implements RestoreFromSource {
  private readonly branchSearchCache=new Map<string,{repo:RepositoryDescriptor;until:number;value:Promise<readonly BranchInfo[]>}>();
  private readonly fetchTimes = new Map<string, number>();
  private readonly fetched = new Emitter<string>();
  /** Fires after a fetch completes, even when it changed nothing that status can show. */
  readonly onDidFetch = (listener: () => void) => this.fetched.event(() => listener());
  lastFetched(id: string): number | undefined { return this.fetchTimes.get(id); }
  constructor(readonly registry: RepositoryRegistry, readonly executor: GitExecutor, private readonly policy: PathPolicy,
    private readonly coordinator: OperationCoordinator, private readonly backend: DailyBackend) {
    // An invalidation (a refresh, ref activity, a trailing reload; it names no repository) means refs may have changed outside Git Pro: the display cache only
    // spares bursts of reads between invalidations. Subscribed before any view, so views that reload on the same event read fresh refs.
    registry.onDidInvalidate?.(() => this.branchSearchCache.clear());
  }
  repository(id: string): RepositoryDescriptor {
    const repo = this.registry.list().find(item => item.id === id);
    if (!repo) throw new Error('Repository is no longer open.'); return repo;
  }
  authorizePath(id: string, file: string): Promise<string> { return this.policy.authorizeFile(this.repository(id).root, file); }
  private async ready(id: string): Promise<Ready> {
    const repo = this.repository(id); await this.policy.authorizeRoot(repo.root);
    const raw = (await this.executor.read(repo.root, { kind: 'status' })).stdout, status = parseStatus(raw);
    if (await detectOperation(repo.gitDir, gitPseudoRefs(this.executor, repo.root)) !== 'idle') throw new DailyError('operation', 'A Git operation is in progress. Finish or abort it first: Git Pro: Resolve Conflicts… lists its conflicts, and Operation Actions… continues or aborts it.');
    if (this.repository(id) !== repo) throw new DailyError('stale', 'Repository changed. Refresh and review again.');
    return { repo, status, raw };
  }
  /** Fresh status of an idle repository: one Git read, for callers that only need what is changed. */
  async state(id: string): Promise<StatusSnapshot> { return (await this.ready(id)).status; }
  /**
   * Absolute paths of entries to act on. A symlink is an entry like any file (Git records the link, never its target). A submodule or nested
   * repository is a single entry too, which only staging and unstaging can use (`repositories`): Discard and Get from Branch leave it alone.
   */
  private async paths(repo: RepositoryDescriptor, values: readonly string[], repositories = false): Promise<string[]> {
    if (!values.length || values.length > 5000) throw new Error('Select between 1 and 5000 files.');
    const unique = [...new Set(values)], files = await this.policy.authorizeEntries(repo.root, unique);
    // Authorization already placed every file inside this repository; only a registered repository nested in it could own one.
    const nested = this.registry.list().some(other => other.id !== repo.id && containsPath(repo.root, other.root));
    // Bounded parallelism: up to 5000 files would otherwise queue thousands of filesystem calls at once.
    for (let start = 0; start < files.length; start += 64) {
      await Promise.all(files.slice(start, start + 64).map(async (file, offset) => {
        const info = await lstat(file).catch(() => undefined);
        const isRepository = info?.isDirectory() === true && await lstat(path.join(file, '.git')).then(() => true, () => false);
        if (nested) {
          // A link belongs to the folder that holds it, wherever it points; a nested repository's own root is an entry of this repository.
          const owner = await this.registry.resolveFile(info?.isSymbolicLink() ? path.dirname(file) : file);
          if (owner?.id !== repo.id && !(owner && isRepository && path.relative(owner.root, file) === '')) throw new Error('Select files belonging to this repository, excluding nested repositories.');
        }
        if (isRepository && !repositories) throw new Error(`${path.basename(file)} is a submodule or nested repository. Git Pro can stage and unstage it, but Discard and Get from Branch leave it alone.`);
        // Only a submodule (a gitlink the index already holds) is staged as one entry. A repository Git does not track yet would be added as an embedded repository,
        // a gitlink with no .gitmodules, which is rarely meant and which Git only warns about.
        if (isRepository && !(await this.executor.read(repo.root, { kind: 'index', paths: [unique[start + offset]!.replace(/\/+$/, '')] })).stdout.length) {
          throw new Error(`${path.basename(file)} is a repository of its own that this repository does not track yet. Staging it would add an embedded repository without a .gitmodules entry; use a terminal if you mean that.`);
        }
        if (info?.isDirectory() && !isRepository) throw new Error('Select individual changed files rather than directories.');
      }));
    }
    return files;
  }
  /**
   * Reviewable fingerprint of the state an action depends on: HEAD and branch refs, the staged index (from the status
   * bytes already read, so no whole-index listing) and, only when `paths` are given for a discard, their working content.
   */
  async preview(id: string, paths: readonly string[] = []): Promise<DailyPreview> {
    return this.describe(await this.ready(id), paths, true);
  }
  private async describe({ repo, status, raw }: Ready, paths: readonly string[], working: boolean): Promise<DailyPreview> {
    if (paths.length) await this.paths(repo, paths);
    // Content is hashed for the scoped paths only; a repository-wide `git diff --binary` is unbounded and never needed here.
    let digest = '';
    if (working && paths.length) {
      const hash = createHash('sha256');
      // Batched so the paths fit one command line; each batch is bounded on its own.
      // Hashed while streaming, so discarding a very large file is not refused by the read output bound.
      for (const batch of chunkPaths(paths)) hash.update((await this.executor.read(repo.root, { kind: 'workDiff', paths: batch }, { digest: true })).digest!);
      // Untracked contents are absent from git diff. Include them for discard previews.
      const selected = new Set(paths);
      for (const change of status.changes.filter(item => item.group === 'untracked' && selected.has(item.path))) {
        const file = await this.policy.authorizeFile(repo.root, change.path);
        const info = await stat(file); if (info.size > 5 * 1024 * 1024) throw new Error('File exceeds safe discard preview limit.');
        hash.update(await readFile(file));
      }
      digest = hash.digest('hex');
    }
    // Ref identities plus the branch configuration that defines upstreams: asking for-each-ref for %(upstream) itself
    // costs seconds with thousands of branches, while these two reads stay near a tenth of a second.
    const [identities, config] = await Promise.all([this.executor.read(repo.root, { kind: 'branchIdentities' }), this.executor.read(repo.root, { kind: 'branchConfig' })]);
    const refs = createHash('sha256').update(identities.stdout).update('\0\0').update(config.stdout).digest('hex');
    return { repositoryId: repo.id, head: status.oid, refs, index: stagedFingerprint(raw), working: digest, paths: [...paths], status };
  }
  /** `current` is the fresh state this action already read inside the coordinator, so no second status read is needed. */
  private async checkPreview(preview: DailyPreview, current: Ready, working = false): Promise<void> {
    const now = await this.describe(current, preview.paths, working);
    if (now.head !== preview.head || now.status.head !== preview.status.head || now.refs !== preview.refs || now.index !== preview.index || (working && now.working !== preview.working)) {
      throw new DailyError('stale', 'HEAD, index or reviewed content changed. Review the action again.');
    }
  }
  private run<T>(id: string, action: (ready: Ready) => Promise<T>): Promise<T> {
    const repo = this.repository(id);
    const invalidateBranches = () => {
      for (const [key, cached] of this.branchSearchCache) {
        if (cached.repo.commonDir === repo.commonDir) this.branchSearchCache.delete(key);
      }
    };
    return this.coordinator.run(repo.commonDir, async () => {
      invalidateBranches(); return action(await this.ready(id));
    }, () => {
      // A display read may have populated the cache during a partially failing action.
      invalidateBranches(); return this.registry.refresh(id);
    });
  }
  stage(id: string, paths: readonly string[]): Promise<void> {
    return this.run(id, ({ repo }) => this.stagePaths(repo, paths));
  }
  /** Stages every working-tree and untracked change in fresh status. Returns the count; a clean tree is a no-op. */
  stageAll(id: string): Promise<number> {
    return this.run(id, async ({ repo, status }) => {
      // An untracked directory shown with a trailing slash is a repository of its own; staging it would embed it as a gitlink, so Stage All leaves it out.
      const paths = status.changes.filter(change => (change.group === 'working' || change.group === 'untracked') && !(change.group === 'untracked' && change.path.endsWith('/'))).map(change => change.path);
      if (paths.length) await this.stagePaths(repo, paths);
      return paths.length;
    });
  }
  private async stagePaths(repo: RepositoryDescriptor, paths: readonly string[]): Promise<void> {
    if (!paths.length) throw new Error('Select files to stage.');
    await inGroups(paths, async group => {
      const absolute = await this.paths(repo, group, true);
      if (group.some(value => /[?*\[]/.test(value))) await this.executor.mutate(repo.root, { kind: 'stage', paths: group });
      // The built-in Git API splits long path lists itself; one call per group means one VS Code status refresh.
      else await this.backend.stage(repo.root, absolute);
    });
  }
  unstage(id: string, paths: readonly string[]): Promise<void> {
    return this.run(id, ready => this.unstagePaths(ready, paths));
  }
  /** Unstages every staged change in fresh status. Returns the count; an empty index is a no-op. */
  unstageAll(id: string): Promise<number> {
    return this.run(id, async ready => {
      const paths = ready.status.changes.filter(change => change.group === 'staged').map(change => change.path);
      if (paths.length) await this.unstagePaths(ready, paths);
      return paths.length;
    });
  }
  private async unstagePaths({ repo, status }: Ready, paths: readonly string[]): Promise<void> {
    if (!paths.length) throw new Error('Select files to unstage.');
    // A staged rename is unstaged with its original path, or its deletion side would stay staged. A copy leaves its source in place, so that stays staged.
    const expanded = new Set(paths);
    for (const change of status.changes) if (change.group === 'staged' && change.status === 'R' && expanded.has(change.path) && change.originalPath) expanded.add(change.originalPath);
    await inGroups([...expanded], async group => {
      await this.paths(repo, group, true);
      await this.executor.mutate(repo.root, { kind: status.oid ? 'unstage' : 'unstageUnborn', paths: group });
    });
  }
  /** Splits a Discard selection (a folder may bring many paths) into what Discard can restore and the intent-to-add files it must leave alone. */
  async discardable(id: string, paths: readonly string[]): Promise<{ targets: string[]; skipped: string[] }> {
    const placeholders = new Set((await this.state(id)).changes.filter(isIntentToAdd).map(change => change.path));
    return { targets: paths.filter(file => !placeholders.has(file)), skipped: paths.filter(file => placeholders.has(file)) };
  }
  discard(preview: DailyPreview): Promise<void> {
    return this.run(preview.repositoryId, async ready => {
      await this.checkPreview(preview, ready, true);
      const repo = this.repository(preview.repositoryId); await this.paths(repo, preview.paths);
      const selected = new Set(preview.paths);
      if (preview.status.changes.some(item => item.group === 'untracked' && selected.has(item.path))) {
        throw new Error('Untracked deletion is not supported by this action. Delete explicitly in Explorer.');
      }
      // `git add -N` records an empty placeholder, so Git holds no copy of the content: a restore would leave the file empty.
      const placeholder = ready.status.changes.find(item => isIntentToAdd(item) && selected.has(item.path));
      if (placeholder) throw new Error(`${placeholder.path} was added with "git add -N", so Git has no copy of its content and Discard would empty it. Stage it first, or delete it yourself.`);
      await this.executor.mutate(repo.root, { kind: 'discard', paths: preview.paths });
    });
  }
  /**
   * Get from Branch (§3.8, N7): `restore --source=<oid> --worktree` for exactly the reviewed paths, which also removes a tracked path the source lacks.
   * Idle repository, coordinator lock and the reviewed working content of those paths; the index is untouched.
   */
  restoreFromSource(preview: DailyPreview, oid: string): Promise<void> {
    validateOid(oid);
    return this.run(preview.repositoryId, async ready => {
      if (!preview.paths.length) throw new Error('Select files to get from the branch.');
      await this.checkPreview(preview, ready, true);
      const repo = this.repository(preview.repositoryId), selected = [...new Set(preview.paths)], absolute = await this.paths(repo, selected);
      if (ready.status.changes.some(item => item.group === 'conflicts' && selected.includes(item.path))) throw new DailyError('conflict', 'Resolve the conflicts in the selected files first.');
      const untracked = await this.untrackedOnDisk(repo, selected, absolute);
      if (untracked.length) throw new DailyError('dirty', `${untracked[0]} is not tracked by Git${untracked.length > 1 ? ` (and ${untracked.length - 1} more)` : ''}. Get from Branch would overwrite it, and Git keeps no copy to restore it from. Move or delete it first.`);
      // `ls-files` lists an intent-to-add entry like a tracked file, so the check above passes it, yet its content is not in Git either.
      const intended = intentToAdd(ready.status, selected);
      if (intended.length) throw new DailyError('dirty', `${intended[0]} is only marked for adding (git add -N)${intended.length > 1 ? ` (and ${intended.length - 1} more)` : ''}. Get from Branch would overwrite or delete it, and Git keeps no copy to restore it from. Stage it, or move it first.`);
      await this.executor.mutate(repo.root, { kind: 'restoreFromSource', oid, paths: preview.paths });
    });
  }
  /**
   * Selected paths that exist on disk but not in the index: untracked or ignored files. `git diff <oid>` shows such a path only as the branch's file, and
   * `restore --source` would overwrite it with nothing in Git to recover it from, which is why discard refuses untracked paths too.
   */
  private async untrackedOnDisk(repo: RepositoryDescriptor, paths: readonly string[], absolute: readonly string[]): Promise<string[]> {
    const present: string[] = [];
    for (let start = 0; start < paths.length; start += 64) {
      const found = await Promise.all(absolute.slice(start, start + 64).map(file => lstat(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; })));
      present.push(...paths.slice(start, start + 64).filter((_, index) => found[index]));
    }
    const tracked = new Set<string>();
    for (const group of chunkPaths(present)) for (const entry of parseIndex((await this.executor.read(repo.root, { kind: 'index', paths: group })).stdout)) tracked.add(entry.path);
    return present.filter(file => !tracked.has(file));
  }
  commit(preview: DailyPreview, message: string, options: CommitRequest, push = false): Promise<CommitResult> {
    return this.run(preview.repositoryId, async ready => {
      if (!message.trim() || message.includes('\0') || message.length > 65536) throw new Error('Enter a non-empty commit message (maximum 65536 characters).');
      await this.checkPreview(preview, ready);
      const repo = this.repository(preview.repositoryId);
      if (options.amend && !preview.head) throw new Error('There is no commit to amend.');
      // Amending with nothing staged is how only the message is changed.
      if (!options.amend && !preview.status.changes.some(item => item.group === 'staged') && !preview.status.omitted?.some(item => item.group === 'staged')) throw new DailyError('empty-index', 'Stage changes first. Git Pro never automatically stages files during commit.');
      await this.backend.commit(repo.root, message, options);
      const oid = (await this.executor.read(repo.root, { kind: 'ref', ref: 'HEAD' })).stdout.toString('utf8').trim();
      if (!push) return { oid, pushed: false };
      try { await this.pushCurrent(repo); return { oid, pushed: true }; }
      catch (error) { return { oid, pushed: false, pushError: recoveryFor(error).message }; }
    });
  }
  /** Remotes without the idle-repository check of `remotes`: listing them for a view is harmless in the middle of a merge or rebase, and must not cost a status read. */
  async listRemotes(id: string): Promise<readonly RemoteInfo[]> { const repo = this.repository(id); await this.policy.authorizeRoot(repo.root); return this.backend.remotes(repo.root); }
  async remotes(id: string): Promise<readonly RemoteInfo[]> { const { repo } = await this.ready(id); return this.backend.remotes(repo.root); }
  private async remote(repo: RepositoryDescriptor, name: string | undefined): Promise<string> {
    const remotes = await this.backend.remotes(repo.root);
    const found = name ? remotes.find(item => item.name === name) : remotes.length === 1 ? remotes[0] : undefined;
    if (!found) throw new DailyError('publish', 'Choose a remote to fetch or publish this branch.');
    validateBranchName(found.name);
    for (const url of [found.fetchUrl, found.pushUrl]) if (url && (/^\s*-|[\r\n\0]/.test(url) || /^(?!https?:|ssh:|git:|file:)[a-z][a-z0-9+.-]*:\/\//i.test(url) || url.includes('::'))) throw new Error('Unsupported remote transport. Use HTTPS, SSH or an explicit local remote.');
    return found.name;
  }
  fetch(id: string, remote?: string): Promise<void> {
    return this.run(id, async () => {
      const repo = this.repository(id); await this.backend.fetch(repo.root, await this.remote(repo, remote));
      this.fetchTimes.set(id, Date.now()); this.fetched.fire(id);
    });
  }
  /** Applies a safety copy of the tracked working changes (the commit `git stash create` made) to the working tree; nothing is stashed, and the stash list is untouched. */
  applySafetyCopy(id: string, oid: string): Promise<void> {
    validateOid(oid);
    return this.run(id, async ({ repo }) => { await this.executor.mutate(repo.root, { kind: 'stashApply', oid, index: false }); });
  }
  /**
   * Brings pull request `number` of `remote` in as `refs/gitpro/pr/<remote>/<number>` and returns that ref. The built-in Git does the transfer, so its credentials apply, and nothing else
   * in the repository changes: no branch, no working tree, no status.
   */
  fetchPullRequest(id: string, remote: string, web: RemoteWeb, number: number): Promise<string> {
    return this.run(id, async () => {
      const repo = this.repository(id), name = await this.remote(repo, remote), refspec = pullRequestRefspec(web, name, number);
      if (!refspec) throw new Error('This host does not publish pull requests as Git refs. Fetch the source branch instead.');
      await this.backend.fetch(repo.root, name, refspec);
      return pullRequestRef(name, number);
    });
  }
  /** `known` must come from a read taken inside this coordinator slot with no mutation since; otherwise Git is asked again. */
  private async pushCurrent(repo: RepositoryDescriptor, publish?: { remote: string; branch: string }, known?: StatusSnapshot): Promise<void> {
    const status = known ?? parseStatus((await this.executor.read(repo.root, { kind: 'status' })).stdout);
    if (!status.head || status.head === '(detached)' || !status.oid) throw new DailyError('detached', 'Create a local branch with a commit before publishing.');
    if (!publish && !status.upstream) throw new DailyError('no-upstream', 'No upstream configured. Choose a remote and publish this branch.');
    const remoteName = publish?.remote ?? (await this.backend.remotes(repo.root)).map(item => item.name).sort((a, b) => b.length - a.length).find(name => status.upstream?.startsWith(`${name}/`));
    const remote = await this.remote(repo, remoteName);
    const branch = publish?.branch ?? status.upstream!.slice(remote.length + 1);
    validateBranchName(branch);
    if (branch !== status.head) throw new Error('Publishing to a differently named remote branch is not supported by the baseline API. Choose the current branch name.');
    await this.backend.push(repo.root, remote, status.head, !!publish);
  }
  push(id: string, publish?: { remote: string; branch: string }, preview?: DailyPreview): Promise<void> { return this.run(id, async ready => { if (preview) await this.checkPreview(preview, ready); await this.pushCurrent(this.repository(id), publish, ready.status); }); }
  pull(id: string, strategy: 'ff-only' | 'merge' | 'rebase', preview?: DailyPreview): Promise<void> {
    return this.run(id, async ready => {
      if (preview) await this.checkPreview(preview, ready);
      const { repo, status } = ready;
      if (hasChanges(status)) throw new DailyError('dirty', 'Commit or stash local changes before pulling.');
      if (!status.upstream) throw new DailyError('no-upstream', 'Set an upstream branch before pulling.');
      const remoteName = (await this.backend.remotes(repo.root)).map(item => item.name).sort((a, b) => b.length - a.length).find(name => status.upstream?.startsWith(`${name}/`));
      await this.backend.fetch(repo.root, await this.remote(repo, remoteName));
      this.fetchTimes.set(id, Date.now()); this.fetched.fire(id);
      const fresh = await this.ready(id);
      if (fresh.status.oid !== status.oid || fresh.status.head !== status.head || fresh.status.upstream !== status.upstream || hasChanges(fresh.status)) throw new DailyError('stale', 'Local branch changed during fetch. Review pull again.');
      if (strategy === 'ff-only' && (fresh.status.ahead ?? 0) > 0 && (fresh.status.behind ?? 0) > 0) throw new DailyError('diverged', 'Branches diverged after fetch. Review the pull strategy.');
      const oid = (await this.executor.read(repo.root, { kind: 'ref', ref: status.upstream })).stdout.toString('utf8').trim();
      await this.executor.mutate(repo.root, { kind: 'integrate', strategy, oid });
    });
  }
  async branches(id: string): Promise<BranchInfo[]> {
    const repo = this.repository(id);
    const output = (await this.executor.read(repo.root, { kind: 'branches' })).stdout.toString('utf8');
    return this.parseBranches(output);
  }
  /** How far each of up to 200 local branches is ahead of and behind its upstream ("↑2 ↓1", or "gone" when the upstream was deleted); a branch with nothing to say is left out. */
  async branchTracking(id:string,refs:readonly string[]):Promise<Map<string,string>>{
    const repo=this.repository(id),found=new Map<string,string>();
    // One read takes at most 200 refs and 12,000 bytes of names; many long branch names go in several reads.
    const batches:string[][]=[];let batch:string[]=[],bytes=0;
    for(const ref of refs){
      const size=Buffer.byteLength(ref)+1;
      if(batch.length&&(batch.length>=200||bytes+size>10000)){batches.push(batch);batch=[];bytes=0;}
      batch.push(ref);bytes+=size;
    }
    if(batch.length)batches.push(batch);
    for(const part of batches)for(const line of (await this.executor.read(repo.root,{kind:'branchTracking',refs:part})).stdout.toString('utf8').split('\n')){
      const [ref='',track='']=line.split('\0'),ahead=/ahead (\d+)/.exec(track)?.[1],behind=/behind (\d+)/.exec(track)?.[1];
      const text=track==='gone'?'gone':[ahead?`↑${ahead}`:'',behind?`↓${behind}`:''].filter(Boolean).join(' ');
      if(ref&&text)found.set(ref,text);
    }
    return found;
  }
  private parseBranches(output:string):BranchInfo[]{
    return output.split('\n').filter(Boolean).map(line => {
      const [ref = '', oid = '', upstream = '', worktree = ''] = line.split('\0');
      const remote = ref.startsWith('refs/remotes/');
      return { ref, oid, upstream, worktree, remote, name: ref.replace(/^refs\/(?:heads|remotes)\//, '') };
    }).filter(branch => !branch.remote || !branch.name.endsWith('/HEAD'));
  }
  /** Display-only cache. Mutation guards always call branches() for fresh refs. */
  branchSearchSnapshot(id:string):Promise<readonly BranchInfo[]>{
    const repo=this.repository(id),cached=this.branchSearchCache.get(id);
    if(cached?.repo===repo&&cached.until>Date.now())return cached.value;
    if(this.branchSearchCache.size>=2)this.branchSearchCache.delete(this.branchSearchCache.keys().next().value!);
    const entry={repo,until:Date.now()+10_000,value:Promise.resolve([] as readonly BranchInfo[])};
    entry.value=displayBranchOutput(async command=>(await this.executor.read(repo.root,command,command.kind==='branchUpstreamKeys'?{maxOutputBytes:1024*1024}:{})).stdout).then(output=>this.parseBranches(output.toString('utf8'))).then(branches=>{
      if(this.repository(id)!==repo)throw new Error('Repository changed during branch search.');
      // Count separately retained strings conservatively; two entries cap this
      // display cache at 64 MiB accounted payload, independent of mutation reads.
      const retainedBytes=branches.reduce((bytes,branch)=>bytes+256+2*Buffer.byteLength(branch.name+branch.ref+branch.oid+branch.upstream+branch.worktree),4096);
      if(branches.length>10000||retainedBytes>32*1024*1024){if(this.branchSearchCache.get(id)===entry)this.branchSearchCache.delete(id);}
      else entry.until=Date.now()+10_000;
      return Object.freeze(branches.map(branch=>Object.freeze({...branch})));
    }).catch(error=>{if(this.branchSearchCache.get(id)===entry)this.branchSearchCache.delete(id);throw error;});
    this.branchSearchCache.set(id,entry);return entry.value;
  }
  createBranch(id: string, name: string, checkout: boolean, base?: string): Promise<void> {
    validateBranchName(name); if (base) validateBranchName(base);
    return this.run(id, async ({ repo, status }) => {
      if (checkout && hasChanges(status)) throw new DailyError('dirty', 'Review or commit local changes before switching branches.');
      await this.backend.createBranch(repo.root, name, checkout, base);
    });
  }
  checkout(id: string, name: string, trackingName?: string): Promise<void> {
    validateBranchName(name); if (trackingName) validateBranchName(trackingName);
    return this.run(id, async ({ repo, status }) => {
      if (hasChanges(status)) throw new DailyError('dirty', 'Commit or stash local changes before switching branches.');
      if (trackingName) {
        await this.backend.createBranch(repo.root, trackingName, true, name);
        await this.backend.setUpstream(repo.root, trackingName, name);
      } else await this.backend.checkout(repo.root, name);
    });
  }
  branchAction(preview: DailyPreview, name: string, action: 'rename' | 'delete' | 'force-delete' | 'unset-upstream', newName?: string): Promise<void> {
    validateBranchName(name); if (newName) validateBranchName(newName);
    return this.run(preview.repositoryId, async ready => {
      await this.checkPreview(preview, ready);
      const repo = this.repository(preview.repositoryId); const branch = (await this.branches(repo.id)).find(item => !item.remote && item.name === name);
      if (!branch) throw new Error('Local branch not found.');
      if (action !== 'unset-upstream' && branch.worktree) throw new Error('Branch is checked out in a worktree. Checkout another branch before renaming or deleting.');
      if (action === 'rename') { if (!newName) throw new Error('Enter a new branch name.'); await this.executor.mutate(repo.root, { kind: 'renameBranch', oldName: name, newName }); }
      else if (action === 'unset-upstream') await this.executor.mutate(repo.root, { kind: 'unsetUpstream', branch: name });
      else await this.backend.deleteBranch(repo.root, name, action === 'force-delete');
    });
  }
  setUpstream(id: string, branch: string, upstream: string): Promise<void> {
    validateBranchName(branch); validateBranchName(upstream);
    return this.run(id, () => this.backend.setUpstream(this.repository(id).root, branch, upstream));
  }
}
