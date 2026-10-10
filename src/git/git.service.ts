import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { GitExecutor } from './git-executor';
import type { DailyBackend, CommitRequest, RemoteInfo } from './daily-backend';
import { parseStatus, stagedFingerprint, type StatusSnapshot } from './git-parser';
import { PathPolicy, containsPath } from '../security/paths';
import { validateBranchName } from '../security/refs';
import { RepositoryRegistry, type RepositoryDescriptor } from '../repositories/repository-registry';
import { OperationCoordinator } from '../state/operation-coordinator';
import { detectOperation } from '../state/operation-state';
import { recoveryFor } from '../utils/recovery';
import { partiallyApplied } from './git-error-parser';
import { displayBranchOutput } from './branch-display';
import { Emitter } from '../utils/events';
import { chunkPaths } from './argv-chunks';

interface Ready { repo: RepositoryDescriptor; status: StatusSnapshot; raw: Buffer }
export interface DailyPreview { repositoryId: string; head: string | undefined; refs: string; index: string; working: string; paths: readonly string[]; status: StatusSnapshot }
export interface BranchInfo { name: string; ref: string; oid: string; remote: boolean; upstream: string; worktree: string }
export class DailyError extends Error {
  constructor(readonly code: 'dirty' | 'no-upstream' | 'detached' | 'stale' | 'operation' | 'empty-index' | 'publish' | 'conflict' | 'diverged', message: string) { super(message); }
}
export interface CommitResult { oid: string; pushed: boolean; pushError?: string }
/** Runs an action per group of at most 5000 paths, the per-call bound. Staging and unstaging are reversible, so a later group failing leaves a reviewable state that the error describes. */
async function inGroups(paths: readonly string[], action: (group: readonly string[]) => Promise<void>): Promise<void> {
  const total = Math.ceil(paths.length / 5000);
  for (let index = 0; index < total; index++) {
    try { await action(paths.slice(index * 5000, (index + 1) * 5000)); }
    catch (error) { throw index ? partiallyApplied(error, index, total) : error; }
  }
}
export class GitService {
  private readonly branchSearchCache=new Map<string,{repo:RepositoryDescriptor;until:number;value:Promise<readonly BranchInfo[]>}>();
  private readonly fetchTimes = new Map<string, number>();
  private readonly fetched = new Emitter<string>();
  /** Fires after a fetch completes, even when it changed nothing that status can show. */
  readonly onDidFetch = (listener: () => void) => this.fetched.event(() => listener());
  lastFetched(id: string): number | undefined { return this.fetchTimes.get(id); }
  constructor(readonly registry: RepositoryRegistry, readonly executor: GitExecutor, private readonly policy: PathPolicy,
    private readonly coordinator: OperationCoordinator, private readonly backend: DailyBackend) {}
  repository(id: string): RepositoryDescriptor {
    const repo = this.registry.list().find(item => item.id === id);
    if (!repo) throw new Error('Repository is no longer open.'); return repo;
  }
  authorizePath(id: string, file: string): Promise<string> { return this.policy.authorizeFile(this.repository(id).root, file); }
  private async ready(id: string): Promise<Ready> {
    const repo = this.repository(id); await this.policy.authorizeRoot(repo.root);
    const raw = (await this.executor.read(repo.root, { kind: 'status' })).stdout, status = parseStatus(raw);
    if (await detectOperation(repo.gitDir) !== 'idle') throw new DailyError('operation', 'A Git operation is in progress. Resolve it in native Source Control before starting another action.');
    if (this.repository(id) !== repo) throw new DailyError('stale', 'Repository changed. Refresh and review again.');
    return { repo, status, raw };
  }
  /** Fresh status of an idle repository: one Git read, for callers that only need what is changed. */
  async state(id: string): Promise<StatusSnapshot> { return (await this.ready(id)).status; }
  private async paths(repo: RepositoryDescriptor, values: readonly string[]): Promise<string[]> {
    if (!values.length || values.length > 5000) throw new Error('Select between 1 and 5000 files.');
    const files = await this.policy.authorizeFiles(repo.root, [...new Set(values)]);
    // Authorization already placed every file inside this repository; only a registered repository nested in it could own one.
    const nested = this.registry.list().some(other => other.id !== repo.id && containsPath(repo.root, other.root));
    // Bounded parallelism: up to 5000 files would otherwise queue thousands of filesystem calls at once.
    for (let start = 0; start < files.length; start += 64) {
      await Promise.all(files.slice(start, start + 64).map(async file => {
        if (nested && (await this.registry.resolveFile(file))?.id !== repo.id) throw new Error('Select files belonging to this repository, excluding nested repositories.');
        const info = await stat(file).catch(() => undefined);
        if (info?.isDirectory()) throw new Error('Select individual changed files rather than directories.');
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
      const paths = status.changes.filter(change => change.group === 'working' || change.group === 'untracked').map(change => change.path);
      if (paths.length) await this.stagePaths(repo, paths);
      return paths.length;
    });
  }
  private async stagePaths(repo: RepositoryDescriptor, paths: readonly string[]): Promise<void> {
    if (!paths.length) throw new Error('Select files to stage.');
    await inGroups(paths, async group => {
      const absolute = await this.paths(repo, group);
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
    // A staged rename is unstaged with its original path, or its deletion side would stay staged.
    const expanded = new Set(paths);
    for (const change of status.changes) if (change.group === 'staged' && expanded.has(change.path) && change.originalPath) expanded.add(change.originalPath);
    await inGroups([...expanded], async group => {
      await this.paths(repo, group);
      await this.executor.mutate(repo.root, { kind: status.oid ? 'unstage' : 'unstageUnborn', paths: group });
    });
  }
  discard(preview: DailyPreview): Promise<void> {
    return this.run(preview.repositoryId, async ready => {
      await this.checkPreview(preview, ready, true);
      const repo = this.repository(preview.repositoryId); await this.paths(repo, preview.paths);
      const selected = new Set(preview.paths);
      if (preview.status.changes.some(item => item.group === 'untracked' && selected.has(item.path))) {
        throw new Error('Untracked deletion is not supported by this action. Delete explicitly in Explorer.');
      }
      await this.executor.mutate(repo.root, { kind: 'discard', paths: preview.paths });
    });
  }
  commit(preview: DailyPreview, message: string, options: CommitRequest, push = false): Promise<CommitResult> {
    return this.run(preview.repositoryId, async ready => {
      if (!message.trim() || message.includes('\0') || message.length > 65536) throw new Error('Enter a non-empty commit message (maximum 65536 characters).');
      await this.checkPreview(preview, ready);
      const repo = this.repository(preview.repositoryId);
      if (!preview.status.changes.some(item => item.group === 'staged')) throw new DailyError('empty-index', 'Stage changes first. Git Pro never automatically stages files during commit.');
      if (options.amend && !preview.head) throw new Error('There is no commit to amend.');
      await this.backend.commit(repo.root, message, options);
      const oid = (await this.executor.read(repo.root, { kind: 'ref', ref: 'HEAD' })).stdout.toString('utf8').trim();
      if (!push) return { oid, pushed: false };
      try { await this.pushCurrent(repo); return { oid, pushed: true }; }
      catch (error) { return { oid, pushed: false, pushError: recoveryFor(error).message }; }
    });
  }
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
      if (status.changes.length) throw new DailyError('dirty', 'Commit or stash local changes before pulling.');
      if (!status.upstream) throw new DailyError('no-upstream', 'Set an upstream branch before pulling.');
      const remoteName = (await this.backend.remotes(repo.root)).map(item => item.name).sort((a, b) => b.length - a.length).find(name => status.upstream?.startsWith(`${name}/`));
      await this.backend.fetch(repo.root, await this.remote(repo, remoteName));
      this.fetchTimes.set(id, Date.now()); this.fetched.fire(id);
      const fresh = await this.ready(id);
      if (fresh.status.oid !== status.oid || fresh.status.head !== status.head || fresh.status.upstream !== status.upstream || fresh.status.changes.length) throw new DailyError('stale', 'Local branch changed during fetch. Review pull again.');
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
      if (checkout && status.changes.length) throw new DailyError('dirty', 'Review or commit local changes before switching branches.');
      await this.backend.createBranch(repo.root, name, checkout, base);
    });
  }
  checkout(id: string, name: string, trackingName?: string): Promise<void> {
    validateBranchName(name); if (trackingName) validateBranchName(trackingName);
    return this.run(id, async ({ repo, status }) => {
      if (status.changes.length) throw new DailyError('dirty', 'Commit or stash local changes before switching branches.');
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
