import * as vscode from 'vscode';
import type { GitService, BranchInfo } from '../../git/git.service';
import { redact } from '../../security/redaction';
import { branchVisual } from '../tree-visuals';
export type BranchNode = { kind: 'group'; remote: boolean } | { kind: 'branch'; repositoryId: string; branch: BranchInfo } | { kind: 'hint'; remotes: boolean };
export class BranchesProvider implements vscode.TreeDataProvider<BranchNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: { dispose(): void };
  /** Ahead and behind counts per repository, for the branches listed when they were asked for; Git counts them per branch, so they are read apart from the list. */
  private readonly tracking = new Map<string, { readonly key: string; readonly until: number; readonly value: Map<string, string> }>();
  constructor(private readonly git: GitService) { this.subscription = git.registry.onDidInvalidate(() => { this.tracking.clear(); this.changed.fire(); }); }
  /**
   * "↑2 ↓1" for each local branch that is ahead of or behind its upstream. A slow count never holds the list up: the list is drawn without it after a short wait
   * and drawn again when the numbers arrive.
   */
  private async tracks(id: string, branches: readonly BranchInfo[]): Promise<Map<string, string>> {
    const key = branches.map(branch => `${branch.ref}@${branch.oid}@${branch.upstream}`).join('|'), hit = this.tracking.get(id);
    if (hit?.key === key && hit.until > Date.now()) return hit.value;
    const entry = { key, until: Date.now() + 15_000, value: new Map<string, string>() };
    this.tracking.set(id, entry);
    const done = Promise.resolve().then(() => this.git.branchTracking(id, branches.map(branch => branch.ref))).then(found => { for (const [ref, text] of found) entry.value.set(ref, text); }, () => { if (this.tracking.get(id) === entry) this.tracking.delete(id); });
    let late = true; const budget = new Promise<void>(resolve => { setTimeout(resolve, 800); });
    await Promise.race([done.then(() => { late = false; }), budget]);
    if (late) void done.then(() => { if (this.tracking.get(id) === entry && entry.value.size) this.changed.fire(); });
    return entry.value;
  }
  async getChildren(node?: BranchNode): Promise<BranchNode[]> {
    const repo = this.git.registry.active; if (!repo) return [];
    if (!node) return [{ kind: 'group', remote: false }, { kind: 'group', remote: true }];
    if (node.kind !== 'group') return [];
    const listed = (await this.git.branchSearchSnapshot(repo.id)).filter(branch => branch.remote === node.remote).slice(0, 200);
    if (!node.remote && listed.length) await this.tracks(repo.id, listed);
    const branches = listed.map((branch): BranchNode => ({ kind: 'branch', repositoryId: repo.id, branch }));
    if (branches.length || !node.remote) return branches;
    // Remote branches are only the ones Git already has locally; say so, and offer the fetch that downloads the rest.
    // A fetch cannot help a repository with no remote, so that case says so instead. If the lookup fails, assume a remote exists.
    const remotes = await this.git.listRemotes(repo.id).then(list => list.length > 0, () => true);
    return [{ kind: 'hint', remotes }];
  }
  getTreeItem(node: BranchNode): vscode.TreeItem {
    if (node.kind === 'hint' && !node.remotes) {
      const item = new vscode.TreeItem('No remote configured', vscode.TreeItemCollapsibleState.None);
      item.description = 'Add one with git remote add'; item.iconPath = new vscode.ThemeIcon('info');
      item.tooltip = 'This repository has no remote, so there are no remote branches to list. Add one with "git remote add <name> <url>", then fetch.';
      return item;
    }
    if (node.kind === 'hint') {
      const item = new vscode.TreeItem('No remote branches downloaded yet', vscode.TreeItemCollapsibleState.None);
      item.description = 'Click to fetch'; item.iconPath = new vscode.ThemeIcon('cloud-download');
      item.tooltip = 'Git Pro lists the remote branches Git already has. Fetch downloads the current list from the remote.';
      item.command = { command: 'gitPro.fetch', title: 'Fetch' }; return item;
    }
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.remote ? 'Remote (first 200; search in Branches)' : 'Local (first 200; search in Branches)', vscode.TreeItemCollapsibleState.Collapsed);
      const visual = branchVisual({ remote: node.remote, current: false });
      item.iconPath = new vscode.ThemeIcon(visual.icon, new vscode.ThemeColor(visual.color));
      return item;
    }
    const item = new vscode.TreeItem(redact(node.branch.name)); item.id = `${node.repositoryId}:${node.branch.ref}`;
    const current = !node.branch.remote && this.git.registry.store.get(node.repositoryId)?.head === node.branch.name;
    // The checked-out branch keeps Branch Actions but not Compare with Current, Merge into Current or Rebase Current onto This.
    item.contextValue = node.branch.remote ? 'gitPro.branch.remote' : current ? 'gitPro.branch.current' : 'gitPro.branch.local';
    const snapshot = this.git.registry.store.get(node.repositoryId), counts = [snapshot?.ahead ? `↑${snapshot.ahead}` : '', snapshot?.behind ? `↓${snapshot.behind}` : ''].filter(Boolean).join(' ');
    const track = current ? counts : node.branch.remote ? '' : this.tracking.get(node.repositoryId)?.value.get(node.branch.ref) ?? '';
    item.description = (current ? 'Current' : node.branch.remote ? `Remote${node.branch.upstream ? ` · ${redact(node.branch.upstream)}` : ''}` : redact(node.branch.upstream)) + (track ? `${current || node.branch.upstream ? ' · ' : ''}${track}` : '');
    item.tooltip = redact(`${node.branch.name}\n${node.branch.oid}${node.branch.worktree ? `\nChecked out: ${node.branch.worktree}` : ''}`);
    const visual = branchVisual({ remote: node.branch.remote, current });
    item.iconPath = new vscode.ThemeIcon(visual.icon, new vscode.ThemeColor(visual.color));
    // A click only selects; the actions are in the view's own menu and behind the inline Branch Actions button.
    return item;
  }
  dispose(): void { this.subscription.dispose(); this.changed.dispose(); }
}
