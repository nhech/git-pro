import * as vscode from 'vscode';
import type { FileChange, ChangeGroup } from '../../git/git-parser';
import type { RepositoryRegistry } from '../../repositories/repository-registry';
import type { RepositorySnapshot } from '../../state/repository-store';
import type { OperationSummary } from '../../git/conflicts/conflict-contract';
import { redact } from '../../security/redaction';
import { createSurfaces, type Surfaces } from '../../conflicts/surfaces';
import { operationBanner, type OperationBanner } from '../../conflicts/operation-text';
import { unlistedChanges } from './unlisted';
import { changeFileVisual, changeGroupVisual, changeStatusLabel } from '../tree-visuals';
import { changeQuery, changeScheme } from './change-decorations';
export type ChangeNode = { kind: 'group'; repositoryId: string; group: ChangeGroup } | {kind:'folder';repositoryId:string;group:ChangeGroup;prefix:string} | { kind: 'file'; repositoryId: string; change: FileChange } | { kind: 'message'; message: string }
  /** The operation in progress (a merge, a rebase…), as the first row of the view, with its actions. */
  | { kind: 'operation'; repositoryId: string; banner: OperationBanner };
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
  /** The operation summary words the banner better than the status alone; it is read once per snapshot and the row is drawn again when it arrives. */
  private readonly summaries = new WeakMap<RepositorySnapshot, OperationSummary>();
  private readonly requested = new WeakSet<RepositorySnapshot>();
  constructor(private readonly registry: RepositoryRegistry, private readonly surfaces: Surfaces = createSurfaces()) {
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
  /** The banner of the operation in progress in this repository, or nothing; the commands behind its buttons check against this before they act. */
  currentBanner(repositoryId: string): OperationBanner | undefined {
    const snapshot = this.registry.store.get(repositoryId);
    if (!snapshot) return undefined;
    const conflicts = snapshot.changes.filter(change => change.group === 'conflicts').length;
    if (!operationBanner(snapshot.operation, conflicts)) return undefined;
    if (!this.summaries.has(snapshot) && !this.requested.has(snapshot)) {
      this.requested.add(snapshot);
      let pending: Promise<OperationSummary> | undefined;
      try { pending = this.surfaces.operation?.summary(repositoryId); } catch { pending = undefined; }
      void pending?.then(summary => { this.summaries.set(snapshot, summary); if (this.registry.store.get(repositoryId) === snapshot) this.changed.fire(); }, () => undefined);
    }
    const banner = operationBanner(snapshot.operation, conflicts, this.summaries.get(snapshot));
    return banner && { ...banner, text: redact(banner.text) };
  }
  getChildren(node?: Node): Node[] {
    if(node&&(node.kind==='file'||node.kind==='message'||node.kind==='operation'))return[];
    const repo = this.registry.active;
    if (!repo) return [];
    const error = this.registry.errors.get(repo.id);
    if (error) return [{ kind: 'message', message: error }];
    const changes = this.registry.store.get(repo.id)?.changes;
    if (!changes) return [{ kind: 'message', message: 'Loading repository status…' }];
    if (!node) {
      const banner = this.currentBanner(repo.id), operation: Node[] = banner ? [{ kind: 'operation', repositoryId: repo.id, banner }] : [];
      // Entries whose names Git Pro cannot show stay visible as a line of their own, beside the groups that can be listed.
      const unlisted: Node[] = this.registry.store.get(repo.id)?.omitted?.length ? [{ kind: 'message', message: unlistedChanges }] : [];
      if (changes.length) return [...operation, ...(['conflicts', 'staged', 'working', 'untracked'] as const)
        .filter(group => changes.some(change => change.group === group)).map((group): Node => ({ kind: 'group', repositoryId: repo.id, group })), ...unlisted];
      return [...operation, ...(unlisted.length ? unlisted : banner ? [] : [{ kind: 'message', message: 'Working tree clean' } as Node])];
    }
    if(node.kind!=='group'&&node.kind!=='folder')return[];
    const prefix=node.kind==='folder'?node.prefix:'';
    if(this.grouping(repo)!=='folder')return changes.filter(change=>change.group===node.group&&change.path.startsWith(prefix)).map(change=>({kind:'file',repositoryId:repo.id,change}));
    const found=this.directories(changes,node.group).get(prefix);
    if(!found)return[];
    return [...[...found.folders].sort().map(folder=>({kind:'folder' as const,repositoryId:repo.id,group:node.group,prefix:folder})),...found.files.map(change=>({kind:'file' as const,repositoryId:repo.id,change}))];
  }
  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'message') return new vscode.TreeItem(redact(node.message));
    if (node.kind === 'operation') {
      const { banner } = node, item = new vscode.TreeItem(banner.text);
      item.id = `${node.repositoryId}:operation`;
      item.iconPath = new vscode.ThemeIcon(banner.icon, new vscode.ThemeColor(banner.icon === 'warning' ? 'charts.red' : banner.icon === 'pass' ? 'charts.green' : 'charts.orange'));
      // The buttons the banner offers now, as words a menu can test; a click opens the same choices as a list, with the reason for each one that is unavailable.
      item.contextValue = ['gitPro.operation', ...banner.actions.filter(action => !action.disabled).map(action => action.id)].join(' ');
      item.tooltip = redact([banner.text, ...banner.actions.map(action => action.disabled ? `${action.label}: ${action.disabled}` : action.title)].join('\n'));
      item.command = { command: 'gitPro.operation.menu', title: 'Operation Actions' };
      return item;
    }
    if(node.kind==='folder'){
      const item=new vscode.TreeItem(redact(node.prefix.split('/').at(-2)??node.prefix),vscode.TreeItemCollapsibleState.Collapsed);
      item.id=`${node.repositoryId}:${node.group}:folder:${node.prefix}`;item.contextValue=`gitPro.change.folder.${node.group}`;item.iconPath=new vscode.ThemeIcon('folder');item.tooltip=redact(node.prefix);return item;
    }
    if (node.kind === 'group') {
      const labels = { staged: 'Staged', working: 'Working Tree', untracked: 'Untracked', conflicts: 'Conflicts' };
      const item = new vscode.TreeItem(labels[node.group], vscode.TreeItemCollapsibleState.Expanded);
      item.id = `${node.repositoryId}:${node.group}`; item.contextValue = `gitPro.group.${node.group}`;
      item.iconPath = this.asThemeIcon(changeGroupVisual[node.group]);
      item.description = String(this.registry.store.get(node.repositoryId)?.changes.filter(change=>change.group===node.group).length??0); return item;
    }
    const path = redact(node.change.path), slash = path.lastIndexOf('/'), name = path.slice(slash + 1), folder = slash > 0 ? path.slice(0, slash) : '';
    const item = new vscode.TreeItem(name);
    item.id = `${node.repositoryId}:${node.change.group}:${node.change.path}`;
    // Conflict kinds follow Yours/Theirs, which a rebase swaps (D3).
    const operation = node.change.group === 'conflicts' ? this.registry.store.get(node.repositoryId)?.operation : undefined;
    const status = changeStatusLabel(node.change, operation), repo = this.registry.list().find(value => value.id === node.repositoryId);
    // The directory reads beside the name when the list is flat; under a folder row it is already said. The status is the letter at the row's far edge (the URI's decoration);
    // a conflict also says its kind, which a letter cannot.
    const parts = [repo && this.grouping(repo) === 'folder' ? '' : folder, node.change.originalPath ? `← ${redact(node.change.originalPath)}` : '', node.change.group === 'conflicts' ? status : ''].filter(Boolean);
    if (parts.length) item.description = parts.join(' · ');
    item.contextValue = `gitPro.change.${node.change.group}`;
    item.resourceUri = vscode.Uri.from({ scheme: changeScheme, path: `/${node.change.path}`, query: changeQuery(node.change) });
    item.tooltip = `${path}\n${status}${node.change.group === 'staged' ? ' (staged)' : ''}`;
    item.iconPath = this.asThemeIcon(changeFileVisual(node.change));
    // A conflicted file has no diff to show (Git refuses one during an operation).
    item.command = node.change.group === 'conflicts' ? { command: 'gitPro.resolveConflict', title: 'Resolve Conflict', arguments: [node] } : { command: 'gitPro.diff', title: 'Open Diff', arguments: [node] };
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
