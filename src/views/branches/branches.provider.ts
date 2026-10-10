import * as vscode from 'vscode';
import type { GitService, BranchInfo } from '../../git/git.service';
import { redact } from '../../security/redaction';
import { branchVisual } from '../tree-visuals';
export type BranchNode = { kind: 'group'; remote: boolean } | { kind: 'branch'; repositoryId: string; branch: BranchInfo };
export class BranchesProvider implements vscode.TreeDataProvider<BranchNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: { dispose(): void };
  constructor(private readonly git: GitService) { this.subscription = git.registry.onDidInvalidate(() => this.changed.fire()); }
  async getChildren(node?: BranchNode): Promise<BranchNode[]> {
    const repo = this.git.registry.active; if (!repo) return [];
    if (!node) return [{ kind: 'group', remote: false }, { kind: 'group', remote: true }];
    if (node.kind !== 'group') return [];
    return (await this.git.branchSearchSnapshot(repo.id)).filter(branch => branch.remote === node.remote).slice(0, 200)
      .map(branch => ({ kind: 'branch', repositoryId: repo.id, branch }));
  }
  getTreeItem(node: BranchNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.remote ? 'Remote (first 200; search in Branches)' : 'Local (first 200; search in Branches)', vscode.TreeItemCollapsibleState.Collapsed);
      const visual = branchVisual({ remote: node.remote, current: false });
      item.iconPath = new vscode.ThemeIcon(visual.icon, new vscode.ThemeColor(visual.color));
      return item;
    }
    const item = new vscode.TreeItem(redact(node.branch.name)); item.id = `${node.repositoryId}:${node.branch.ref}`;
    item.contextValue = node.branch.remote ? 'gitPro.branch.remote' : 'gitPro.branch.local';
    const current = this.git.registry.store.get(node.repositoryId)?.head === node.branch.name;
    item.description = current ? 'Current' : node.branch.remote ? `Remote${node.branch.upstream ? ` · ${redact(node.branch.upstream)}` : ''}` : redact(node.branch.upstream);
    item.tooltip = redact(`${node.branch.name}\n${node.branch.oid}${node.branch.worktree ? `\nChecked out: ${node.branch.worktree}` : ''}`);
    const visual = branchVisual({ remote: node.branch.remote, current });
    item.iconPath = new vscode.ThemeIcon(visual.icon, new vscode.ThemeColor(visual.color));
    item.command = { command: 'gitPro.branchActions', title: 'Branch Actions', arguments: [node] }; return item;
  }
  dispose(): void { this.subscription.dispose(); this.changed.dispose(); }
}
