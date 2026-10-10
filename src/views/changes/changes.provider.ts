import * as vscode from 'vscode';
import type { FileChange, ChangeGroup } from '../../git/git-parser';
import type { RepositoryRegistry } from '../../repositories/repository-registry';
import { redact } from '../../security/redaction';
import { changeFileVisual, changeGroupVisual, changeStatusLabel } from '../tree-visuals';
export type ChangeNode = { kind: 'group'; group: ChangeGroup } | {kind:'folder';repositoryId:string;group:ChangeGroup;prefix:string} | { kind: 'file'; repositoryId: string; change: FileChange } | { kind: 'message'; message: string };
type Node = ChangeNode;
/** Immediate children of one folder prefix within a status group, indexed once per snapshot. */
interface Directory { readonly folders: Set<string>; readonly files: FileChange[] }
export class ChangesProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: { dispose(): void }[];
  private index: { readonly changes: readonly FileChange[]; readonly groups: Map<ChangeGroup, Map<string, Directory>> } | undefined;
  private readonly groupings = new Map<string, string>();
  private readonly icons = new Map<string, vscode.ThemeIcon>();
  constructor(private readonly registry: RepositoryRegistry) {
    this.subscriptions = [registry.onDidChange(() => this.changed.fire()),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('gitPro.changes.groupBy')) { this.groupings.clear(); this.changed.fire(); } })];
  }
  /** Read once per repository until the setting changes: a full tree build asks for it once per folder otherwise. */
  private grouping(repo: { readonly id: string; readonly root: string }): string {
    let mode = this.groupings.get(repo.id);
    if (mode === undefined) { mode = vscode.workspace.getConfiguration('gitPro', vscode.Uri.file(repo.root)).get<string>('changes.groupBy', 'status'); this.groupings.set(repo.id, mode); }
    return mode;
  }
  /** One pass over a group builds every folder's children; looking each folder up is then O(children), not O(all changes). */
  private directories(changes: readonly FileChange[], group: ChangeGroup): Map<string, Directory> {
    if (this.index?.changes !== changes) this.index = { changes, groups: new Map() };
    let directories = this.index.groups.get(group);
    if (directories) return directories;
    directories = new Map<string, Directory>();
    const directory = (prefix: string): Directory => {
      let found = directories!.get(prefix);
      if (!found) { found = { folders: new Set(), files: [] }; directories!.set(prefix, found); }
      return found;
    };
    for (const change of changes) {
      if (change.group !== group) continue;
      let parent = '';
      for (let slash = change.path.indexOf('/'); slash >= 0; slash = change.path.indexOf('/', slash + 1)) {
        const folder = change.path.slice(0, slash + 1);
        directory(parent).folders.add(folder); parent = folder;
      }
      directory(parent).files.push(change);
    }
    this.index.groups.set(group, directories);
    return directories;
  }
  getChildren(node?: Node): Node[] {
    if(node&&(node.kind==='file'||node.kind==='message'))return[];
    const repo = this.registry.active;
    if (!repo) return [];
    const error = this.registry.errors.get(repo.id);
    if (error) return [{ kind: 'message', message: error }];
    const changes = this.registry.store.get(repo.id)?.changes;
    if (!changes) return [{ kind: 'message', message: 'Loading repository status…' }];
    if (!node) return changes.length ? (['conflicts', 'staged', 'working', 'untracked'] as const)
      .filter(group => changes.some(change => change.group === group)).map(group => ({ kind: 'group', group })) : [{ kind: 'message', message: 'Working tree clean' }];
    if(node.kind!=='group'&&node.kind!=='folder')return[];
    const prefix=node.kind==='folder'?node.prefix:'';
    if(this.grouping(repo)!=='folder')return changes.filter(change=>change.group===node.group&&change.path.startsWith(prefix)).map(change=>({kind:'file',repositoryId:repo.id,change}));
    const found=this.directories(changes,node.group).get(prefix);
    if(!found)return[];
    return [...[...found.folders].sort().map(folder=>({kind:'folder' as const,repositoryId:repo.id,group:node.group,prefix:folder})),...found.files.map(change=>({kind:'file' as const,repositoryId:repo.id,change}))];
  }
  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'message') return new vscode.TreeItem(redact(node.message));
    if(node.kind==='folder'){
      const item=new vscode.TreeItem(redact(node.prefix.split('/').at(-2)??node.prefix),vscode.TreeItemCollapsibleState.Collapsed);
      item.id=`${node.repositoryId}:${node.group}:folder:${node.prefix}`;item.contextValue=`gitPro.change.folder.${node.group}`;item.iconPath=new vscode.ThemeIcon('folder');item.tooltip=redact(node.prefix);return item;
    }
    if (node.kind === 'group') {
      const labels = { staged: 'Staged', working: 'Working Tree', untracked: 'Untracked', conflicts: 'Conflicts' };
      const item = new vscode.TreeItem(labels[node.group], vscode.TreeItemCollapsibleState.Expanded);
      item.id = `${this.registry.active?.id}:${node.group}`;
      item.iconPath = this.asThemeIcon(changeGroupVisual[node.group]);
      item.description = String(this.registry.active?this.registry.store.get(this.registry.active.id)?.changes.filter(change=>change.group===node.group).length??0:0); return item;
    }
    const label = redact(node.change.path), item = new vscode.TreeItem(label);
    item.id = `${node.repositoryId}:${node.change.group}:${node.change.path}`;
    item.description = changeStatusLabel(node.change); item.contextValue = `gitPro.change.${node.change.group}`;
    item.tooltip = label; item.iconPath = this.asThemeIcon(changeFileVisual(node.change));
    item.command = { command: 'gitPro.diff', title: 'Open Diff', arguments: [node] };
    return item;
  }
  private asThemeIcon(visual: { readonly icon: string; readonly color: string }): vscode.ThemeIcon {
    // Icons are immutable value objects; thousands of rows share a handful of them.
    const key = `${visual.icon}|${visual.color}`;
    let icon = this.icons.get(key);
    if (!icon) { icon = new vscode.ThemeIcon(visual.icon, new vscode.ThemeColor(visual.color)); this.icons.set(key, icon); }
    return icon;
  }
  dispose(): void { for(const subscription of this.subscriptions)subscription.dispose(); this.changed.dispose(); }
}
