import * as vscode from 'vscode';
import * as path from 'node:path';
import type { RepositoryRegistry } from '../../repositories/repository-registry';
import type { ChangeNode, ChangesProvider } from './changes.provider';

/**
 * The Changes view is a native tree of the active repository's changes (see changes.provider.ts): selection, keyboard, menus, icons and theming are the workbench's own.
 * This class owns the view object, its badge and the context key that tells the view/title menu which way the list is grouped.
 */
export class ChangesView implements vscode.Disposable {
  readonly view: vscode.TreeView<ChangeNode>;
  private readonly subscriptions: vscode.Disposable[];
  constructor(private readonly registry: RepositoryRegistry, provider: ChangesProvider) {
    this.view = vscode.window.createTreeView('gitPro.changes', { treeDataProvider: provider, canSelectMany: true, showCollapseAll: true });
    this.subscriptions = [this.view, registry.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('gitPro.changes.groupBy')) this.refresh(); })];
    this.refresh();
  }
  /** What a command run without a clicked row acts on. */
  get selection(): readonly ChangeNode[] { return this.view.selection; }
  get isResolved(): boolean { return this.view.visible; }
  private refresh(): void {
    const repo = this.registry.active, snapshot = repo ? this.registry.store.get(repo.id) : undefined;
    const count = (snapshot?.changes.length ?? 0) + (snapshot?.omitted?.length ?? 0), failed = repo ? this.registry.errors.has(repo.id) : false;
    this.view.badge = repo && !failed && count > 0 ? { value: count, tooltip: `${count} ${count === 1 ? 'change' : 'changes'}` } : undefined;
    this.view.description = repo && this.registry.list().length > 1 ? path.basename(repo.root) : '';
    const mode = repo ? vscode.workspace.getConfiguration('gitPro', vscode.Uri.file(repo.root)).get<string>('changes.groupBy', 'status') : 'status';
    void vscode.commands.executeCommand('setContext', 'gitPro.changes.groupBy', mode === 'folder' ? 'folder' : 'status');
  }
  dispose(): void { for (const subscription of this.subscriptions.splice(0)) subscription.dispose(); }
}
