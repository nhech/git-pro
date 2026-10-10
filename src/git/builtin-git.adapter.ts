import * as vscode from 'vscode';
import * as path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { DailyBackend } from './daily-backend';
import type { API, GitExtension, Repository, Status } from '../types/git';
import type { RepositoryHandle } from '../repositories/repository-registry';
import type { FileChange, StatusSnapshot } from './git-parser';

// Public API v1 Status.UNTRACKED; the vendored declaration has no runtime module.
const nativeUntrackedStatus: Status = 7;

export class BuiltinGitAdapter implements vscode.Disposable {
  private api: API | undefined;
  private readonly apiSubscriptions: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [this.changed];
  readonly onDidChange = this.changed.event;
  get executable(): string {
    if (!this.api) throw new Error('Enable the built-in Git extension to use Git Pro.');
    return this.api.git.path;
  }
  async initialize(): Promise<void> {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) throw new Error('The built-in Git extension is unavailable.');
    const exported = await extension.activate();
    const connect = () => {
      for (const subscription of this.apiSubscriptions.splice(0)) subscription.dispose();
      this.api = exported.enabled ? exported.getAPI(1) : undefined;
      if (this.api) {
        this.apiSubscriptions.push(this.api.onDidOpenRepository(() => this.changed.fire()),
          this.api.onDidCloseRepository(() => this.changed.fire()));
      }
      this.changed.fire();
    };
    this.disposables.push(exported.onDidChangeEnablement(connect));
    connect();
  }
  get enabled(): boolean { return this.api !== undefined; }
  repositories(): RepositoryHandle[] {
    return (this.api?.repositories ?? []).filter(repo => repo.rootUri.scheme === 'file').map(repo => ({
      root: repo.rootUri.fsPath,
      onDidChange: listener => repo.state.onDidChange(listener),
      snapshot: () => this.snapshot(repo)
    }));
  }
  async open(root: string): Promise<void> {
    if (!this.api) throw new Error('Enable the built-in Git extension first.');
    await this.api.openRepository(vscode.Uri.file(root));
  }
  private async repository(root: string): Promise<Repository> {
    if (!this.api) throw new Error('Enable the built-in Git extension first.');
    const canonical = await realpath(root);
    for (const repo of this.api.repositories) {
      const candidate = await realpath(repo.rootUri.fsPath);
      if (process.platform === 'win32' ? candidate.toLowerCase() === canonical.toLowerCase() : candidate === canonical) return repo;
    }
    throw new Error('Repository is no longer available in the built-in Git extension.');
  }
  dailyBackend(): DailyBackend {
    return {
      stage: async (root, paths) => { await (await this.repository(root)).add([...paths]); },
      commit: async (root, message, options) => {
        const repo = await this.repository(root); await repo.status();
        if (!repo.state.indexChanges.length) throw new Error('Stage changes before committing.');
        await repo.commit(message, { ...options, all: false, postCommitCommand: null });
      },
      fetch: async (root, remote) => { await (await this.repository(root)).fetch(remote ? { remote } : {}); },
      push: async (root, remote, branch, setUpstream) => { await (await this.repository(root)).push(remote, branch, setUpstream); },
      createBranch: async (root, name, checkout, base) => { await (await this.repository(root)).createBranch(name, checkout, base); },
      checkout: async (root, name) => { await (await this.repository(root)).checkout(name); },
      deleteBranch: async (root, name, force) => { await (await this.repository(root)).deleteBranch(name, force); },
      setUpstream: async (root, name, upstream) => { await (await this.repository(root)).setBranchUpstream(name, upstream); },
      remotes: async root => (await this.repository(root)).state.remotes.map(remote => ({ name: remote.name,
        ...(remote.fetchUrl ? { fetchUrl: remote.fetchUrl } : {}), ...(remote.pushUrl ? { pushUrl: remote.pushUrl } : {}) }))
    };
  }
  async init(root: string): Promise<void> {
    if (!this.api) throw new Error('Enable Git first.'); await this.api.init(vscode.Uri.file(root), { defaultBranch: 'main' });
  }
  async clone(): Promise<void> {
    // Baseline API has no clone method. Invoke the user-facing built-in workflow
    // without relying on undocumented command argument signatures.
    if (!this.api) throw new Error('Enable Git first.'); await vscode.commands.executeCommand('git.clone');
  }
  capabilities(): Readonly<Record<string, boolean>> {
    const repo = this.api?.repositories[0];
    const optional = repo as unknown as Record<string, unknown> | undefined;
    return Object.freeze({ enabled: this.enabled, restore: typeof optional?.restore === 'function',
      rebase: typeof optional?.rebase === 'function', createStash: typeof optional?.createStash === 'function',
      createWorktree: typeof optional?.createWorktree === 'function' });
  }
  /**
   * The API state in the shape the owned `git status --porcelain=v2` read produces (rename sources, conflict XY codes),
   * so an event that changed nothing compares equal and publishes nothing. Undefined when the API cannot show everything.
   */
  private snapshot(repo: Repository): StatusSnapshot | undefined {
    const state = repo.state;
    // Built-in Git omits untracked files entirely with this preference; owned reads always include them.
    if (vscode.workspace.getConfiguration('git', repo.rootUri).get<string>('untrackedChanges') === 'hidden') return undefined;
    // Indexed by the API's Status enum; conflicts use the porcelain XY pair (ADDED_BY_US is "AU", BOTH_MODIFIED is "UU").
    const statusCodes = ['M', 'A', 'D', 'R', 'C', 'M', 'D', '?', '!', 'A', 'R', 'T', 'AU', 'UA', 'DU', 'UD', 'AA', 'DD', 'UU'];
    const changes: FileChange[] = [];
    const relative = (uri: vscode.Uri): string | undefined => {
      const value = path.relative(repo.rootUri.fsPath, uri.fsPath).replace(/\\/g, '/');
      return !value || value.startsWith('../') || path.isAbsolute(value) ? undefined : value;
    };
    const collect = (items: typeof state.indexChanges, group: FileChange['group']) => {
      for (const item of items) {
        const filePath = relative(item.uri);
        if (!filePath) continue;
        // Native Git's "mixed" preference presents untracked files in Working Tree.
        // Keep our semantic groups stable until the owned status read reconciles.
        const semanticGroup = group === 'working' && item.status === nativeUntrackedStatus ? 'untracked' : group;
        // For a rename or copy (and the working-tree side of a staged rename) the API's original URI is the source path.
        const originalPath = item.originalUri ? relative(item.originalUri) : undefined;
        changes.push({ path: filePath, status: statusCodes[item.status] ?? 'U', group: semanticGroup, ...(originalPath && originalPath !== filePath ? { originalPath } : {}) });
      }
    };
    collect(state.indexChanges, 'staged'); collect(state.workingTreeChanges, 'working');
    collect(state.untrackedChanges, 'untracked'); collect(state.mergeChanges, 'conflicts');
    return Object.freeze({ head: state.HEAD?.name ?? (state.HEAD?.commit ? '(detached)' : undefined),
      oid: state.HEAD?.commit, upstream: state.HEAD?.upstream ? `${state.HEAD.upstream.remote}/${state.HEAD.upstream.name}` : undefined,
      ahead: state.HEAD?.ahead, behind: state.HEAD?.behind,
      changes: Object.freeze(changes.map(change => Object.freeze(change))) });
  }
  dispose(): void {
    for (const subscription of this.apiSubscriptions.splice(0)) subscription.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose(); this.api = undefined;
  }
}
