import * as vscode from 'vscode';
import * as path from 'node:path';
import { redact } from '../../security/redaction';
import type { RepositoryDescriptor, RepositoryRegistry } from '../../repositories/repository-registry';
import { repositoryVisual } from '../tree-visuals';
export class RepositoriesProvider implements vscode.TreeDataProvider<RepositoryDescriptor>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: { dispose(): void };
  constructor(private readonly registry: RepositoryRegistry) { this.subscription = registry.onDidChange(() => this.changed.fire()); }
  getChildren(): RepositoryDescriptor[] { return this.registry.list(); }
  getTreeItem(repo: RepositoryDescriptor): vscode.TreeItem {
    const snapshot = this.registry.store.get(repo.id);
    const item = new vscode.TreeItem(redact(path.basename(repo.root)), vscode.TreeItemCollapsibleState.None);
    item.id = repo.id; item.contextValue = 'gitPro.repository';
    item.description = redact(snapshot?.head ?? 'Unborn HEAD');
    item.tooltip = redact(`${repo.root}\n${snapshot?.operation ?? 'Loading'}${this.registry.errors.get(repo.id) ? `\n${this.registry.errors.get(repo.id)}` : ''}`);
    const visual = repositoryVisual(this.registry.active?.id === repo.id);
    item.iconPath = new vscode.ThemeIcon(visual.icon, new vscode.ThemeColor(visual.color));
    item.command = { command: 'gitPro.selectRepository', title: 'Select Repository', arguments: [repo.id] };
    return item;
  }
  dispose(): void { this.subscription.dispose(); this.changed.dispose(); }
}
