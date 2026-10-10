import * as vscode from 'vscode';
import * as path from 'node:path';
import { GitService, DailyError, type BranchInfo } from '../git/git.service';
import type { CommitRequest } from '../git/daily-backend';
import { DiffService } from '../git/diff/diff.service';
import { RevisionProvider } from '../documents/revision-provider';
import type { ChangeNode } from '../views/changes/changes.provider';
import type { BranchNode } from '../views/branches/branches.provider';
import type { BuiltinGitAdapter } from '../git/builtin-git.adapter';
import { redact } from '../security/redaction';
import { validateBranchName } from '../security/refs';
import { canonicalFilePath } from '../security/paths';
import type { Logger } from '../utils/logging';
import { recoveryFor } from '../utils/recovery';
import { changedPathsInFolder } from '../views/changes/folder-selection';
import type { ChangeGroup } from '../git/git-parser';
import { branchVisual } from '../views/tree-visuals';

export class DailyCommands implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly branchPickers = new Set<vscode.Disposable>();
  readonly diffs: DiffService;
  constructor(private readonly git: GitService, private readonly revisions: RevisionProvider,
    private readonly adapter: BuiltinGitAdapter, private readonly changesView: { readonly selection: readonly ChangeNode[] }, private readonly logger: Logger) {
    this.diffs = new DiffService(git);
    const register = (id: string, action: (...args: unknown[]) => Promise<unknown>) => {
      this.subscriptions.push(vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try { return await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Git Pro: ${id.split('.').at(-1)}` }, () => action(...args)); }
        catch (error) { await this.error(error); }
      }));
    };
    register('gitPro.stage', (arg, selected) => this.fileAction('stage', arg, selected));
    register('gitPro.unstage', (arg, selected) => this.fileAction('unstage', arg, selected));
    register('gitPro.stageFolder', arg => this.fileAction('stage', arg, undefined));
    register('gitPro.unstageFolder', arg => this.fileAction('unstage', arg, undefined));
    register('gitPro.discardFolder', arg => this.fileAction('discard', arg, undefined));
    register('gitPro.stageAll', async () => { if (!await git.stageAll(this.active())) vscode.window.setStatusBarMessage('Git Pro: nothing to stage.', 4000); });
    register('gitPro.unstageAll', async () => { if (!await git.unstageAll(this.active())) vscode.window.setStatusBarMessage('Git Pro: nothing staged.', 4000); });
    register('gitPro.diff', arg => this.diff(arg, false)); register('gitPro.diffHead', arg => this.diff(arg, true));
    register('gitPro.discard', (arg, selected) => this.fileAction('discard', arg, selected));
    register('gitPro.commit', async () => { await vscode.commands.executeCommand('gitPro.commitView.focus'); });
    register('gitPro.fetch', async () => { const id = this.active(); const remote = await this.chooseRemote(id); if (remote) await git.fetch(id, remote); });
    register('gitPro.push', () => this.push());
    register('gitPro.pull', () => this.pull());
    register('gitPro.branches', () => this.branches());
    register('gitPro.branchActions', arg => this.branchActions(arg));
    register('gitPro.createBranch', () => this.createBranch());
    register('gitPro.copyPath', arg => this.copyPath(arg));
    register('gitPro.init', async () => {
      const folders = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: 'Initialize Git Repository' });
      if (!folders?.[0] || folders[0].scheme !== 'file') return;
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace first.');
      await adapter.init(folders[0].fsPath);
      if (await vscode.window.showInformationMessage('Git repository initialized.', 'Open Folder') === 'Open Folder') await vscode.commands.executeCommand('vscode.openFolder', folders[0], true);
    });
    register('gitPro.clone', async () => { if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace first.'); await adapter.clone(); });
  }
  active(): string { const id = this.git.registry.active?.id; if (!id) throw new Error('Select a repository first.'); return id; }
  private async selection(arg: unknown, selected?: unknown): Promise<{ id: string; paths: string[]; change?: ChangeNode; groups: ChangeGroup[] }> {
    if (arg instanceof vscode.Uri) {
      const repo = await this.git.registry.resolveFile(arg.fsPath); if (!repo) throw new Error('File is not in an approved repository.');
      return { id: repo.id, paths: [path.relative(repo.root, await canonicalFilePath(arg.fsPath)).replace(/\\/g, '/')], groups: [] };
    }
    const nodes = Array.isArray(selected) ? selected : arg ? [arg] : this.changesView.selection;
    const entries = nodes.filter((node: unknown): node is Extract<ChangeNode, { kind: 'file'|'folder' }> => !!node && typeof node === 'object' && ((node as ChangeNode).kind === 'file'||(node as ChangeNode).kind==='folder'));
    if (!entries.length) {
      if(nodes.length)throw new Error('Select changed file or folder entries only.');
      const editor = vscode.window.activeTextEditor; if (editor?.document.uri.scheme === 'file') return this.selection(editor.document.uri);
      throw new Error('Select changed files in the Changes view.');
    }
    if(entries.length!==nodes.length)throw new Error('Select changed file or folder entries only.');
    const id=entries[0]!.repositoryId;
    if(entries.some(node=>node.repositoryId!==id))throw new Error('Select files from one repository.');
    const repo=this.git.registry.list().find(item=>item.id===id);if(!repo)throw new Error('Repository is no longer open.');
    const groups=[...new Set(entries.map(node=>node.kind==='file'?node.change.group:node.group))];
    const snapshot=entries.some(node=>node.kind==='folder')?await this.git.state(id):undefined;
    const paths=[...new Set(entries.flatMap(node=>node.kind==='file'?[node.change.path]:changedPathsInFolder(snapshot!.changes,node.group,node.prefix)))];
    if(!paths.length)throw new Error('This folder has no changed files in the selected status group. Refresh and try again.');
    return { id, paths, groups, ...(entries.length===1&&entries[0]!.kind==='file'?{change:entries[0]}:{}) };
  }
  private async fileAction(action: 'stage' | 'unstage' | 'discard', arg: unknown, selected: unknown): Promise<void> {
    const { id, paths, groups } = await this.selection(arg, selected);
    if(action==='stage'&&groups.some(group=>!['working','untracked'].includes(group)))throw new Error('Stage only Working Tree or Untracked entries.');
    if(action==='unstage'&&groups.some(group=>group!=='staged'))throw new Error('Unstage only Staged entries.');
    if(action==='discard'&&groups.some(group=>group!=='working'))throw new Error('Discard only Working Tree entries.');
    if (action === 'stage') await this.git.stage(id, paths);
    else if (action === 'unstage') await this.git.unstage(id, paths);
    else {
      const preview = await this.git.preview(id, paths);
      if (await vscode.window.showWarningMessage(`Discard unstaged changes in ${paths.length} files? Staged content is kept.\n${redact(paths.join('\n'))}`, { modal: true }, 'Discard') === 'Discard') await this.git.discard(preview);
    }
  }
  async diff(arg: unknown, withHead: boolean): Promise<void> {
    const { id, paths, change } = await this.selection(arg);
    const status = await this.git.state(id);
    const entry = change?.kind === 'file' ? status.changes.find(item => item.path === change.change.path && item.group === change.change.group) : status.changes.find(item => item.path === paths[0] && item.group !== 'staged') ?? status.changes.find(item => item.path === paths[0]);
    if (!entry) throw new Error('No local diff for this file.');
    const prepared = await this.diffs.prepare(id, entry, withHead, { head: status.oid });
    const left = this.revisions.add(prepared.left, entry.originalPath ?? entry.path);
    const right = prepared.workingPath ? vscode.Uri.file(prepared.workingPath) : this.revisions.add(prepared.right ?? Buffer.alloc(0), entry.path);
    await vscode.commands.executeCommand('vscode.diff', left, right, redact(prepared.title));
  }
  async commit(id: string, message: string, options: CommitRequest, push: boolean): Promise<boolean> {
    const preview = await this.git.preview(id);
    if (options.amend && await vscode.window.showWarningMessage(`Amend ${preview.head?.slice(0, 12)}? This rewrites the last commit.`, { modal: true }, 'Amend') !== 'Amend') return false;
    if (options.noVerify && await vscode.window.showWarningMessage('Skip Git hooks for this commit?', { modal: true }, 'Skip Hooks') !== 'Skip Hooks') return false;
    const config = vscode.workspace.getConfiguration('gitPro', vscode.Uri.file(this.git.repository(id).root));
    if (config.get<boolean>('commit.confirmBeforeCommit', false) && await vscode.window.showInformationMessage(`Commit ${preview.status.changes.filter(change => change.group === 'staged').length} staged files?`, { modal: true }, 'Commit') !== 'Commit') return false;
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Git Pro: Commit staged changes', cancellable: false }, () => this.git.commit(preview, message, options, push));
    if (result.pushError) await vscode.window.showWarningMessage(`Commit ${result.oid.slice(0, 8)} created; push failed. ${redact(result.pushError)}`, 'Push').then(async choice => { if (choice) { try { await this.push(id); } catch (error) { await this.error(error); } } });
    else await vscode.window.showInformationMessage(`Commit ${result.oid.slice(0, 8)} created${result.pushed ? ' and pushed' : ''}.`);
    return true;
  }
  private async chooseRemote(id: string): Promise<string | undefined> {
    const remotes = await this.git.remotes(id);
    if (!remotes.length) throw new Error('Add a remote in native Source Control before fetching or publishing.');
    if (remotes.length === 1) return remotes[0]!.name;
    return (await vscode.window.showQuickPick(remotes.map(remote => ({ label: redact(remote.name), name: remote.name })), { title: 'Choose Remote' }))?.name;
  }
  private async push(id = this.active()): Promise<void> {
    const preview = await this.git.preview(id);
    const config = vscode.workspace.getConfiguration('gitPro', vscode.Uri.file(this.git.repository(id).root));
    if (config.get<boolean>('confirmBeforePush', false) && await vscode.window.showInformationMessage(`Push ${preview.status.head} to upstream?`, { modal: true }, 'Push') !== 'Push') return;
    if (!preview.status.upstream) {
      const remote = await this.chooseRemote(id); if (!remote) return;
      if (!preview.status.head || preview.status.head === '(detached)') throw new DailyError('detached', 'Create a local branch before pushing.');
      if (await vscode.window.showInformationMessage(`Publish ${preview.status.head} to ${redact(remote)} and set upstream?`, { modal: true }, 'Publish') === 'Publish') await this.git.push(id, { remote, branch: preview.status.head }, preview);
    } else await this.git.push(id, undefined, preview);
  }
  private async pull(): Promise<void> {
    const id = this.active(); const preview = await this.git.preview(id);
    const strategy = vscode.workspace.getConfiguration('gitPro', vscode.Uri.file(this.git.repository(id).root)).get<'ff-only' | 'merge' | 'rebase'>('pull.strategy', 'ff-only');
    try { await this.git.pull(id, strategy, preview); }
    catch (error) {
      if (!(error instanceof DailyError) || error.code !== 'diverged') throw error;
      await this.git.registry.refresh(id);
      const status = this.git.registry.store.get(id);
      if ((status?.ahead ?? 0) > 0 && (status?.behind ?? 0) > 0 && status?.operation === 'idle') {
        const reviewed = await this.git.preview(id);
        if (reviewed.head !== preview.head || reviewed.status.head !== preview.status.head || reviewed.status.upstream !== preview.status.upstream || reviewed.status.changes.length || !(reviewed.status.ahead && reviewed.status.behind)) throw new DailyError('stale', 'Local branch changed. Review pull again.');
        const choice = await vscode.window.showWarningMessage(`Branches diverged. Local +${reviewed.status.ahead}, remote +${reviewed.status.behind}. Rebase rewrites local commits; Merge preserves them.`, { modal: true }, 'Rebase', 'Merge', 'Review Branches');
        if (choice === 'Rebase' || choice === 'Merge') await this.git.pull(id, choice === 'Rebase' ? 'rebase' : 'merge', reviewed);
        else if (choice === 'Review Branches') await vscode.commands.executeCommand('gitPro.branches');
      } else throw error;
    }
  }
  private async createBranch(): Promise<void> {
    const id = this.active(); const name = await vscode.window.showInputBox({ title: 'Create and Checkout Branch', validateInput: value => { try { validateBranchName(value); return undefined; } catch { return 'Invalid branch name'; } } });
    if (name) await this.git.createBranch(id, name, true);
  }
  private async branches(): Promise<void> {
    const id = this.active(), repository = this.git.repository(id);
    type Item = vscode.QuickPickItem & { node?: BranchNode; create?: boolean };
    const picker = vscode.window.createQuickPick<Item>();
    let branches: readonly BranchInfo[] | undefined;
    let live = true, loadError: { error: unknown } | undefined;
    const current = () => this.git.registry.active === repository && this.git.registry.list().includes(repository);
    const populate = (query: string) => {
      if (!live || !branches) return;
      const head = this.git.registry.store.get(id)?.head;
      const matches: Item[] = branches.filter(branch => branch.name.toLowerCase().includes(query.toLowerCase())).slice(0, 200)
        .map(branch => {
          const isCurrent = !branch.remote && branch.name === head, visual = branchVisual({ remote: branch.remote, current: isCurrent });
          return { label: redact(branch.name), description: isCurrent ? 'Current · Local' : branch.remote ? 'Remote' : 'Local',
            iconPath: new vscode.ThemeIcon(visual.icon, new vscode.ThemeColor(visual.color)), node: { kind: 'branch' as const, repositoryId: id, branch } };
        });
      picker.items = [...matches, ...(matches.length ? [{ label: 'Actions', kind: vscode.QuickPickItemKind.Separator }] : []),
        { label: '$(add) New Branch', description: 'Create and checkout a branch', alwaysShow: true, create: true }];
    };
    picker.title = 'Git Pro: Branches'; picker.placeholder = 'Loading branches… Type to search; Escape to close'; picker.busy = true;
    const selected = await new Promise<Item | undefined>(resolve => {
      const listeners: vscode.Disposable[] = [];
      const lifetime = { dispose: () => finish() };
      const finish = (item?: Item) => {
        if (!live) return;
        live = false;
        for (const listener of listeners) listener.dispose();
        this.branchPickers.delete(lifetime);
        picker.hide(); picker.dispose(); resolve(item);
      };
      this.branchPickers.add(lifetime);
      listeners.push(picker.onDidChangeValue(populate), picker.onDidHide(() => finish()),
        picker.onDidAccept(() => {
          if (!current()) { finish(); return; }
          if (!branches) return;
          const item = picker.selectedItems[0];
          if (item && item.kind !== vscode.QuickPickItemKind.Separator && picker.items.includes(item)) finish(item);
        }), this.git.registry.onDidChange(() => { if (!current()) finish(); }));
      const load = async () => {
        try {
          const result = await this.git.branchSearchSnapshot(id);
          if (!live) return;
          if (!current()) { finish(); return; }
          branches = result; populate(picker.value);
          picker.placeholder = 'Search branches (first 200 matching results)'; picker.busy = false;
        } catch (error) {
          if (!live) return;
          if (current()) loadError = { error };
          finish();
        }
      };
      try { picker.show(); if (live) void load(); }
      catch (error) { loadError = { error }; finish(); }
    });
    if (loadError) throw loadError.error;
    if (!selected || !current()) return;
    if (selected.create) await this.createBranch();
    else if (selected.node) await this.branchActions(selected.node);
  }
  private async branchActions(arg: unknown): Promise<void> {
    const node = arg as BranchNode;
    if (!node || node.kind !== 'branch') return this.branches();
    const { branch, repositoryId: id } = node;
    type Action = 'Checkout' | 'Checkout Tracking Branch' | 'Rename' | 'Set Upstream' | 'Unset Upstream' | 'Copy Name' | 'Delete' | 'Force Delete';
    type Item = vscode.QuickPickItem & { action?: Action };
    const item = (action: Action, description: string, icon: string): Item => ({ label: action, action, description, iconPath: new vscode.ThemeIcon(icon) });
    const copy = item('Copy Name', 'Copy the full branch name', 'copy');
    const actions: Item[] = branch.remote ? [item('Checkout Tracking Branch', 'Create a local branch that tracks this remote', 'git-branch'), copy] : [
      item('Checkout', 'Switch to this local branch', 'git-branch'), item('Rename', 'Change the local branch name', 'edit'),
      item('Set Upstream', 'Choose a remote tracking branch', 'link'), item('Unset Upstream', 'Remove local tracking configuration', 'remove'), copy,
      { label: 'Delete branch', kind: vscode.QuickPickItemKind.Separator },
      item('Delete', 'Delete a local branch if fully merged', 'trash'), item('Force Delete', 'Unmerged commits may become unreachable', 'warning'),
    ];
    const choice = (await vscode.window.showQuickPick(actions, { title: redact(branch.name) }))?.action;
    if (!choice) return;
    if (choice === 'Copy Name') { await vscode.env.clipboard.writeText(branch.name); return; }
    if (choice === 'Checkout') { await this.git.checkout(id, branch.name); return; }
    if (choice === 'Checkout Tracking Branch') {
      const name = await vscode.window.showInputBox({ title: 'Local Tracking Branch Name', value: branch.name.slice(branch.name.indexOf('/') + 1) });
      if (name) await this.git.checkout(id, branch.name, name); return;
    }
    if (choice === 'Set Upstream') {
      const selected = await vscode.window.showQuickPick((await this.git.branches(id)).filter(item => item.remote).map(item => item.name));
      if (selected) await this.git.setUpstream(id, branch.name, selected); return;
    }
    const preview = await this.git.preview(id);
    if (!(await this.git.branches(id)).some(item => item.ref === branch.ref && item.oid === branch.oid)) throw new Error('Branch changed. Reopen Branch Actions before continuing.');
    if (choice === 'Rename') {
      const name = await vscode.window.showInputBox({ title: 'Rename Branch', value: branch.name });
      if (name) await this.git.branchAction(preview, branch.name, 'rename', name); return;
    }
    if (choice === 'Unset Upstream') { await this.git.branchAction(preview, branch.name, 'unset-upstream'); return; }
    if (await vscode.window.showWarningMessage(`${choice} ${redact(branch.name)} at ${branch.oid.slice(0, 12)}?${choice === 'Force Delete' ? ' Unmerged commits may become unreachable.' : ''}`, { modal: true }, choice) === choice) await this.git.branchAction(preview, branch.name, choice === 'Force Delete' ? 'force-delete' : 'delete');
  }
  private async copyPath(arg: unknown): Promise<void> { await vscode.env.clipboard.writeText((await this.selection(arg)).paths.join('\n')); }
  async error(error: unknown): Promise<void> {
    const recovery=recoveryFor(error);this.logger.error(recovery.diagnostic);
    const choice = await vscode.window.showErrorMessage(`Git Pro: ${recovery.message}`, recovery.label,'Open Source Control');
    if(choice===recovery.label)await vscode.commands.executeCommand(recovery.command);
    if (choice === 'Open Source Control') await vscode.commands.executeCommand('workbench.view.scm');
  }
  dispose(): void {
    for (const picker of this.branchPickers) picker.dispose();
    for (const disposable of this.subscriptions.splice(0)) disposable.dispose();
  }
}
