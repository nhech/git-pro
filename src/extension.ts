import * as vscode from 'vscode';
import { BuiltinGitAdapter } from './git/builtin-git.adapter';
import { GitExecutor } from './git/git-executor';
import { resolveGitExecutable } from './git/git-executable';
import { atLeast, minimumGit, readGitVersion } from './git/git-version';
import { PathPolicy, canonicalFilePath, refuseGitMetadata } from './security/paths';
import { redact } from './security/redaction';
import { RepositoryRegistry } from './repositories/repository-registry';
import { discoverRepositories } from './repositories/repository-discovery';
import { RepositoryStore } from './state/repository-store';
import { OperationCoordinator } from './state/operation-coordinator';
import { RepositoriesProvider } from './views/repositories/repositories.provider';
import { ChangesProvider } from './views/changes/changes.provider';
import { ChangesView } from './views/changes/changes-view';
import { ChangeDecorationProvider } from './views/changes/change-decoration-provider';
import type { ChangeNode } from './views/changes/changes.provider';
import { StatusbarController } from './statusbar/statusbar.controller';
import { SafeLogger } from './utils/logging';
import { GitService } from './git/git.service';
import { DailyCommands } from './commands/daily.commands';
import { RevisionProvider } from './documents/revision-provider';
import { BranchesProvider } from './views/branches/branches.provider';
import { trackSelection } from './views/view-keys';
import { CommitComposer } from './webviews/commit/commit-composer';
import { AutoFetch } from './git/auto-fetch';
import type { RepositorySnapshot } from './state/repository-store';
import { HistoryService } from './git/history/history.service';
import { HistoryPanel } from './webviews/graph/history-panel';
import * as path from 'node:path';
import { BlameController } from './editor/blame-controller';
import { FileBlame } from './editor/file-blame';
import { HistoryCodeLens } from './editor/history-codelens';
import { AdvancedService } from './git/advanced/advanced.service';
import { AdvancedCommands } from './commands/advanced.commands';
import { InteractiveService } from './git/rebase/interactive.service';
import { workspaceRebaseJournal } from './git/rebase/workspace-journal';
import { RebasePlanner } from './webviews/rebase/rebase-planner';
import { ToolsService } from './git/tools/tools.service';
import { RemoteLinks } from './git/remote-links.service';
import { UndoService, gitUndoBackend } from './git/undo/undo.service';
import { registerUndo } from './commands/undo.commands';
import { WorktreeService } from './git/tools/worktree.service';
import { ToolsCommands } from './commands/tools.commands';
import { ToolsProvider } from './views/tools/tools.provider';
import { boundedInteger } from './utils/settings';
import { recoveryFor } from './utils/recovery';
import { FileActionsCommands } from './commands/file-actions.commands';
import { createSurfaces, conflictsAutoOpen, isConflictFailure, openConflictsAfterFailure, type FeatureDeps } from './conflicts/surfaces';
import { registerConflicts } from './commands/conflicts.commands';
import { registerOperation } from './commands/operation.commands';
import { registerCompare } from './commands/compare.commands';
import { registerMenus } from './commands/menu.commands';

export interface ExtensionDiagnostics {
  repositories: () => number;
  activeRepository: () => string | undefined;
  capabilities: () => Readonly<Record<string, boolean>>;
  activeSnapshot: () => RepositorySnapshot | undefined;
  viewItemCounts: () => { repositories: number; groups: number; files: number };
  historyPanelCount:()=>number;
  changesViewResolved:()=>boolean;
}
export async function activate(context: vscode.ExtensionContext): Promise<ExtensionDiagnostics | undefined> {
  const output = vscode.window.createOutputChannel('Git Pro'); context.subscriptions.push(output);
  const logger = new SafeLogger(line => output.appendLine(line), () => vscode.workspace.getConfiguration('gitPro').get('logging.level', 'info'));
  const roots = () => (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
  let gitEnabled = true;
  const policy = new PathPolicy(roots, () => gitEnabled && vscode.workspace.isTrusted && (vscode.workspace.workspaceFolders ?? []).every(folder => folder.uri.scheme === 'file'));
  context.subscriptions.push(vscode.commands.registerCommand('gitPro.showOutput', () => output.show()));
  if (!vscode.workspace.isTrusted) { logger.info('Open a trusted filesystem workspace to use Git Pro.'); return; }
  if (!roots().length) logger.info('Initialize or clone a repository, then open its folder for daily Git actions.');
  /** Until Git Pro can start, its other contributed commands explain why instead of failing as unknown commands. */
  const unavailable = (reason: string): vscode.Disposable => {
    const manifest = context.extension.packageJSON as { contributes?: { commands?: { command?: unknown }[] } };
    const ids = (manifest.contributes?.commands ?? []).map(item => item.command).filter((id): id is string => typeof id === 'string' && id !== 'gitPro.showOutput');
    const registrations = vscode.Disposable.from(...ids.map(id => vscode.commands.registerCommand(id, async () => {
      if (await vscode.window.showErrorMessage(`Git Pro: ${reason}`, 'Show Output') === 'Show Output') output.show();
    })));
    context.subscriptions.push(registrations); return registrations;
  };
  const adapter = new BuiltinGitAdapter(); context.subscriptions.push(adapter);
  try { await adapter.initialize(); } catch (error) { logger.error(String(error)); unavailable('The built-in Git extension is unavailable. Enable it, then reload the window.'); return; }
  const start = async (): Promise<ExtensionDiagnostics | undefined> => {
    let gitExecutable: string;
    try { gitExecutable = await resolveGitExecutable(adapter.executable, roots()); policy.checkTrust(); }
    catch (error) { logger.error(String(error)); unavailable('Git could not be started. See the Git Pro output, then reload the window.'); return; }
    // Below the minimum, committing, pulling and History fail on the first revision Git Pro passes; say so once instead of failing action by action.
    const gitVersion = await readGitVersion(gitExecutable);
    if (gitVersion && !atLeast(gitVersion, minimumGit)) {
      logger.error(`Git ${gitVersion.text} is older than the ${minimumGit.major}.${minimumGit.minor} that Git Pro needs.`);
      unavailable(`Git ${gitVersion.text} is too old. Git Pro needs Git ${minimumGit.major}.${minimumGit.minor} or newer. Update Git, then reload the window.`); return;
    }
    const executor = new GitExecutor(gitExecutable, policy, logger, undefined, process.env, {node:process.execPath,helper:vscode.Uri.joinPath(context.extensionUri,'media','helpers','preserve-editor.cjs').fsPath},()=>{
      const config=vscode.workspace.getConfiguration('gitPro');
      return {readTimeoutMs:boundedInteger(config.get('cli.readTimeout'),15,5,600)*1000,mutationTimeoutMs:boundedInteger(config.get('cli.timeout'),120,15,600)*1000,networkTimeoutMs:boundedInteger(config.get('cli.networkTimeout'),180,30,900)*1000};
    });
    const store = new RepositoryStore();
    // Polling is only a safety net behind the built-in Git API events, so it pauses while the window is unfocused and catches up on focus.
    const registry = new RepositoryRegistry(policy, executor, store, logger, 5000, { isActive: () => vscode.window.state.focused, isBusy: repo => coordinator.busy(repo.commonDir) });
    // Enablement is checked before trust: git.enabled=false is folded into the trust policy, and would otherwise be reported as an untrusted workspace.
    const coordinator = new OperationCoordinator(() => { if (!adapter.enabled) throw new Error('Built-in Git is disabled.'); policy.checkTrust(); });
    // One late-bound holder: the register* calls below fill in the feature surfaces these constructors use.
    const surfaces = createSurfaces();
    const providers = { repositories: new RepositoriesProvider(registry), changes: new ChangesProvider(registry, surfaces) };
    const changesView = new ChangesView(registry, providers.changes);
    const git = new GitService(registry, executor, policy, coordinator, adapter.dailyBackend());
    const statusbar = new StatusbarController(registry, id => git.lastFetched(id), git.onDidFetch, surfaces);
    const autoFetch = new AutoFetch(git, logger);
    const revisions = new RevisionProvider();
    const advanced = new AdvancedService(git,coordinator);
    const interactive = new InteractiveService(advanced,vscode.Uri.joinPath(context.globalStorageUri,'rebase-jobs').fsPath,{node:process.execPath,helper:vscode.Uri.joinPath(context.extensionUri,'media','helpers','rebase-editor.cjs').fsPath},
      workspaceRebaseJournal(context.workspaceState));
    advanced.setEditorJobs(interactive);
    const planner=new RebasePlanner(context,surfaces.menus);context.subscriptions.push(planner);
    // What a discard, a hard reset or a force push would lose is kept first, for Undo….
    const undo = new UndoService(gitUndoBackend(git), context.workspaceState);
    const advancedCommands = new AdvancedCommands(advanced,revisions,interactive,planner,context.extensionUri,surfaces,undo);
    const fileActions = new FileActionsCommands(advanced,revisions);
    const tools = new ToolsService(advanced);
    const toolsProvider = new ToolsProvider(tools);
    const toolsView=vscode.window.createTreeView('gitPro.toolsView',{treeDataProvider:toolsProvider});
    // F2 and Delete in this view are scoped to the kind of item selected (stash, tag, remote, worktree) by a context key.
    context.subscriptions.push(toolsProvider,toolsView,trackSelection(toolsView,'gitPro.toolsView.item',item=>toolsProvider.getTreeItem(item).contextValue));
    const history = new HistoryService(registry, executor, policy);
    const toolsCommands = new ToolsCommands(tools,new WorktreeService(tools,policy),history,revisions,surfaces);
    const links = new RemoteLinks({ remotes: id => tools.remotes(id), upstream: id => registry.store.get(id)?.upstream || undefined,
      hosts: id => { const repo = registry.list().find(item => item.id === id); return vscode.workspace.getConfiguration('gitPro', repo ? vscode.Uri.file(repo.root) : undefined).get('remoteHosts'); } });
    const historyPanels = new HistoryPanel(context, history, revisions, surfaces.menus, links);
    const blame = new BlameController(history, registry,(id,oid)=>historyPanels.open(id,undefined,oid,true));
    const fileBlame = new FileBlame(history, registry, links, (id,oid)=>historyPanels.open(id,undefined,oid,true));
    const historyCodeLens = new HistoryCodeLens(registry, policy);
    context.subscriptions.push(historyCodeLens, vscode.languages.registerCodeLensProvider({scheme:'file'}, historyCodeLens));
    const daily = new DailyCommands(git, revisions, adapter, changesView, logger, surfaces, undo);
    const branches = new BranchesProvider(git);
    // Ctrl/Shift-click selects two branches for Compare Branches; a click only selects, and the branch's actions are in its menu.
    const branchesView = vscode.window.createTreeView('gitPro.branchesView', { treeDataProvider: branches, canSelectMany: true });
    daily.branchesView = branchesView;
    const composer = new CommitComposer(context, git, (id, message, options, push) => daily.commit(id, message, options, push),logger);
    const lifetime = new AbortController();
    context.subscriptions.push({ dispose: () => lifetime.abort() }, executor, store, registry, coordinator,
      providers.repositories, providers.changes, statusbar,
      vscode.window.createTreeView('gitPro.repositories', { treeDataProvider: providers.repositories }),
      changesView, new ChangeDecorationProvider(),
      revisions, daily, branches, composer, autoFetch, history, historyPanels, blame, fileBlame,
      vscode.workspace.registerTextDocumentContentProvider('git-pro-revision', revisions),
      branchesView, trackSelection(branchesView, 'gitPro.branchesView.item', item => branches.getTreeItem(item).contextValue),
      vscode.window.registerWebviewViewProvider('gitPro.commitView', composer));
    const command = (id: string, action: (...args: unknown[]) => Promise<unknown>) => {
      context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try { if (!adapter.enabled) throw new Error('Enable the built-in Git extension first.'); policy.checkTrust(); return await action(...args); }
        catch (error) {
          const recovery=recoveryFor(error);logger.error(recovery.diagnostic);
          // GitFailure names no repository; every Git Pro mutation acts on the active one, and its refresh has run before the rejection arrives here.
          const repo=registry.active,snapshot=repo?store.get(repo.id):undefined,conflict=isConflictFailure(error);
          if(conflict&&repo)await openConflictsAfterFailure(surfaces,{error,repositoryId:repo.id,conflicts:snapshot?.changes.filter(change=>change.group==='conflicts').length??0,
            mode:conflictsAutoOpen(vscode.workspace.getConfiguration('gitPro',vscode.Uri.file(repo.root)).get('conflicts.autoOpen'))}).catch((failure:unknown)=>{logger.error(recoveryFor(failure).diagnostic);return false;});
          // Abort only navigates to the operation command, which asks before it changes anything.
          const abort=conflict&&snapshot&&['merging','rebasing','cherry-picking','reverting'].includes(snapshot.operation)?'Abort…':undefined;
          const choice=await vscode.window.showErrorMessage(`Git Pro: ${recovery.message}`,recovery.label,...(abort?[abort]:[]));
          if(choice===recovery.label)await vscode.commands.executeCommand(recovery.command);
          else if(abort&&choice===abort)await vscode.commands.executeCommand('gitPro.operation.abort');
        }
      }));
    };
    command('gitPro.refresh', () => registry.refresh());
    command('gitPro.advancedActions',()=>advancedCommands.actions());
    command('gitPro.resolveConflict',arg=>advancedCommands.conflict(arg));
    command('gitPro.forcePushWithLease',()=>advancedCommands.forcePush());
    command('gitPro.interactiveRebase',()=>advancedCommands.rebasePlan());
    command('gitPro.hunkActions',arg=>fileActions.hunks(arg));
    command('gitPro.commitFile',arg=>fileActions.commitFile(arg));
    command('gitPro.repositoryTools',(category,id,key)=>toolsCommands.actions(category,id,key));
    command('gitPro.history', async () => {
      const repo = registry.active; if (!repo) throw new Error('Select a repository first.');
      historyPanels.open(repo.id);
    });
    command('gitPro.historyRefs',async()=>{
      const repo=registry.active;if(!repo)throw new Error('Select a repository first.');
      const showRemote=vscode.workspace.getConfiguration('gitPro',vscode.Uri.file(repo.root)).get('graph.showRemoteBranches',true);
      const [branches,tags]=await Promise.all([git.branchSearchSnapshot(repo.id),tools.tags(repo.id)]);
      if(branches.length>10000)throw new Error('More than 10000 branches. Enter exact refs in History & Compare.');
      const head=store.get(repo.id)?.head;
      const items=[...branches.filter(branch=>showRemote||!branch.remote).map(branch=>({label:redact(branch.name),description:branch.remote?'Remote branch':'Local branch',ref:branch.ref,picked:!branch.remote&&branch.name===head})),...tags.slice(0,500).map(tag=>({label:redact(tag.name),description:'Tag',ref:`refs/tags/${tag.name}`,picked:false}))];
      if(!items.length){historyPanels.open(repo.id);return;}
      const selected=await vscode.window.showQuickPick(items,{title:tags.length>500?'History refs — first 500 tags; exact refs remain available in the panel':'History refs — choose up to 128 branches/tags',canPickMany:true,matchOnDescription:true,ignoreFocusOut:true});
      if(!selected?.length)return;if(selected.length>128)throw new Error('Choose at most 128 refs.');
      if(!registry.list().some(current=>current===repo))throw new Error('Repository changed during ref selection.');
      historyPanels.open(repo.id,undefined,selected.map(item=>item.ref).join('\n'));
    });
    command('gitPro.toggleBlame', async () => {
      // blame.enabled is resource-scoped, so read it for the active file and write it where it already lives: a folder or workspace value that exists stays
      // the effective one, and otherwise the user settings are used, so the toggle never creates or edits the repository's own .vscode/settings.json.
      const configuration = vscode.workspace.getConfiguration('gitPro', vscode.window.activeTextEditor?.document.uri), inspected = configuration.inspect<boolean>('blame.enabled');
      const target = inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await configuration.update('blame.enabled', !configuration.get('blame.enabled', false), target);
    });
    command('gitPro.openBlameCommit',async()=>blame.openCurrentCommit());
    // Blame of the whole file in the gutter, and the links of its hover card (which name a commit of a repository that is open).
    command('gitPro.blame.toggleFile',()=>fileBlame.toggle());
    command('gitPro.blame.openCommit',async argument=>fileBlame.open(argument));
    command('gitPro.blame.copyHash',argument=>fileBlame.copyHash(argument));
    command('gitPro.blame.openOnRemote',argument=>fileBlame.openOnRemote(argument));
    /** The row of the Changes view a menu was opened on (a file row), or nothing. */
    const changedFile = (value: unknown): { repositoryId: string; path: string } | undefined => {
      const row = value as { kind?: unknown; repositoryId?: unknown; change?: { path?: unknown } } | undefined;
      return row?.kind === 'file' && typeof row.repositoryId === 'string' && typeof row.change?.path === 'string' ? { repositoryId: row.repositoryId, path: row.change.path } : undefined;
    };
    command('gitPro.fileHistory', async uri => {
      const row = changedFile(uri), root = row ? registry.list().find(item => item.id === row.repositoryId)?.root : undefined;
      if (row && !root) throw new Error('Repository is no longer open.');
      const target = row ? vscode.Uri.file(path.join(root!, ...row.path.split('/'))) : uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== 'file') throw new Error('Open a file in a repository.');
      const repo = await registry.resolveFile(target.fsPath); if (!repo) throw new Error('File is outside an open repository.');
      const relative = path.relative(repo.root, await canonicalFilePath(target.fsPath)).replace(/\\/g, '/'); await policy.authorizeFile(repo.root, relative);
      historyPanels.open(repo.id, relative);
    });
    command('gitPro.selectRepository', async id => {
      if (typeof id === 'string') { registry.select(id); return; }
      const selected = await vscode.window.showQuickPick(registry.list().map(repo => ({ label: redact(repo.root), id: repo.id })), { title: 'Git Pro: Select Repository' });
      if (selected) registry.select(selected.id);
    });
    command('gitPro.openFile', async (first, second) => {
      const row = changedFile(first), id = row ? row.repositoryId : first, relative = row ? row.path : second;
      if (typeof id !== 'string' || typeof relative !== 'string') throw new Error('Select a changed file from Git Pro.');
      const repo = registry.list().find(item => item.id === id);
      if (!repo) throw new Error('Repository is no longer open.');
      const file = await policy.authorizeFile(repo.root, relative);
      await refuseGitMetadata(repo, relative, file);
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
    });
    const deps:FeatureDeps={registry,policy,executor,logger,git,advanced,conflicts:advancedCommands.conflicts,tools,history,historyPanels,revisions,links,undo,surfaces};
    registerOperation(context,deps,command);registerConflicts(context,deps,command);registerCompare(context,deps,command);registerUndo(deps,command,advancedCommands);registerMenus(context,deps,command,{advanced:advancedCommands,tools:toolsCommands,selectedTool:()=>toolsView.selection.length===1?toolsView.selection[0]:undefined});
    let syncTail: Promise<void> = Promise.resolve();
    const synchronize = () => {
      syncTail = syncTail.then(async () => {
        if (lifetime.signal.aborted) return;
        gitEnabled = adapter.enabled;
        await registry.sync(adapter.enabled ? adapter.repositories() : []);
        await vscode.commands.executeCommand('setContext', 'gitPro.hasRepositories', registry.list().length > 0);
      }).catch(error => logger.error(String(error)));
      return syncTail;
    };
    context.subscriptions.push(adapter.onDidChange(() => { void synchronize(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { void synchronize(); }),
      vscode.window.onDidChangeWindowState(state => { if (state.focused) registry.wake(); }));
    await synchronize();
    try {
      // The built-in Git's own scan settings decide whether and how deep nested repositories are looked for, so Git Pro never opens (and thereby auto-fetches)
      // repositories the user chose not to detect: only `true` and `subFolders` scan sub-folders, the depth is git.repositoryScanMaxDepth (capped), and
      // git.repositoryScanIgnoredFolders is honoured.
      const git = vscode.workspace.getConfiguration('git'), detection = git.get<boolean | string>('autoRepositoryDetection', true);
      if (detection === true || detection === 'subFolders') {
        const configured = git.get<number>('repositoryScanMaxDepth', 1), ignoredFolders = git.get<unknown>('repositoryScanIgnoredFolders', ['node_modules']);
        for (const root of await discoverRepositories(roots(), policy, { signal: lifetime.signal, maxDepth: configured < 0 ? 3 : Math.min(configured, 3),
          ignoredFolders: Array.isArray(ignoredFolders) ? ignoredFolders.filter((name): name is string => typeof name === 'string') : [] })) {
          if (lifetime.signal.aborted) break;
          await adapter.open(root);
        }
      }
      await synchronize();
    } catch (error) { logger.error(String(error)); }
    logger.info(`Foundation ready: ${registry.list().length} repositories.`);
    const countFiles=(nodes:readonly ChangeNode[]):number=>nodes.reduce((count,node)=>count+(node.kind==='file'?1:node.kind==='group'||node.kind==='folder'?countFiles(providers.changes.getChildren(node)):0),0);
    return {
      repositories: () => registry.list().length, activeRepository: () => registry.active?.id,
      capabilities: () => adapter.capabilities(), activeSnapshot: () => registry.active ? store.get(registry.active.id) : undefined,
      historyPanelCount:()=>historyPanels.activePanelCount,
      changesViewResolved:()=>changesView.isResolved,
      viewItemCounts: () => ({ repositories: providers.repositories.getChildren().length,
        groups: providers.changes.getChildren().filter(node => node.kind === 'group').length,
        files: countFiles(providers.changes.getChildren()) })
    };
  };
  if (adapter.enabled) return start();
  logger.error('Enable the built-in Git extension to use Git Pro.');
  // Start as soon as Git is enabled instead of staying inert until the window reloads.
  const waiting = unavailable('Enable the built-in Git extension (setting git.enabled) to use Git Pro.');
  const enablement = adapter.onDidChange(() => {
    if (!adapter.enabled) return;
    enablement.dispose(); waiting.dispose();
    void start().catch((error: unknown) => logger.error(String(error)));
  });
  context.subscriptions.push(enablement);
  return undefined;
}
export function deactivate(): void { /* Resources belong to ExtensionContext.subscriptions. */ }
