import * as vscode from 'vscode';
import { BuiltinGitAdapter } from './git/builtin-git.adapter';
import { GitExecutor } from './git/git-executor';
import { resolveGitExecutable } from './git/git-executable';
import { PathPolicy, canonicalFilePath } from './security/paths';
import { redact } from './security/redaction';
import { RepositoryRegistry } from './repositories/repository-registry';
import { discoverRepositories } from './repositories/repository-discovery';
import { RepositoryStore } from './state/repository-store';
import { OperationCoordinator } from './state/operation-coordinator';
import { RepositoriesProvider } from './views/repositories/repositories.provider';
import { ChangesProvider } from './views/changes/changes.provider';
import { ChangesPanel } from './views/changes/changes-panel';
import type { ChangeNode } from './views/changes/changes.provider';
import { StatusbarController } from './statusbar/statusbar.controller';
import { SafeLogger } from './utils/logging';
import { GitService } from './git/git.service';
import { DailyCommands } from './commands/daily.commands';
import { RevisionProvider } from './documents/revision-provider';
import { BranchesProvider } from './views/branches/branches.provider';
import { CommitComposer } from './webviews/commit/commit-composer';
import { AutoFetch } from './git/auto-fetch';
import type { RepositorySnapshot } from './state/repository-store';
import { HistoryService } from './git/history/history.service';
import { HistoryPanel } from './webviews/graph/history-panel';
import * as path from 'node:path';
import { BlameController } from './editor/blame-controller';
import { HistoryCodeLens } from './editor/history-codelens';
import { AdvancedService } from './git/advanced/advanced.service';
import { AdvancedCommands } from './commands/advanced.commands';
import { InteractiveService } from './git/rebase/interactive.service';
import { workspaceRebaseJournal } from './git/rebase/workspace-journal';
import { RebasePlanner } from './webviews/rebase/rebase-planner';
import { ToolsService } from './git/tools/tools.service';
import { WorktreeService } from './git/tools/worktree.service';
import { ToolsCommands } from './commands/tools.commands';
import { ToolsProvider } from './views/tools/tools.provider';
import { boundedInteger } from './utils/settings';
import { recoveryFor } from './utils/recovery';
import { FileActionsCommands } from './commands/file-actions.commands';

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
    const executor = new GitExecutor(gitExecutable, policy, logger, undefined, process.env, {node:process.execPath,helper:vscode.Uri.joinPath(context.extensionUri,'media','helpers','preserve-editor.cjs').fsPath},()=>{
      const config=vscode.workspace.getConfiguration('gitPro');
      return {readTimeoutMs:boundedInteger(config.get('cli.readTimeout'),15,5,600)*1000,mutationTimeoutMs:boundedInteger(config.get('cli.timeout'),120,15,600)*1000,networkTimeoutMs:boundedInteger(config.get('cli.networkTimeout'),180,30,900)*1000};
    });
    const store = new RepositoryStore();
    // Polling is only a safety net behind the built-in Git API events, so it pauses while the window is unfocused and catches up on focus.
    const registry = new RepositoryRegistry(policy, executor, store, logger, 5000, { isActive: () => vscode.window.state.focused, isBusy: repo => coordinator.busy(repo.commonDir) });
    const coordinator = new OperationCoordinator(() => { policy.checkTrust(); if (!adapter.enabled) throw new Error('Built-in Git is disabled.'); });
    const providers = { repositories: new RepositoriesProvider(registry), changes: new ChangesProvider(registry) };
    const changesPanel = new ChangesPanel(context,registry,providers.changes);
    const git = new GitService(registry, executor, policy, coordinator, adapter.dailyBackend());
    const statusbar = new StatusbarController(registry, id => git.lastFetched(id), git.onDidFetch);
    const autoFetch = new AutoFetch(git, logger);
    const revisions = new RevisionProvider();
    const advanced = new AdvancedService(git,coordinator);
    const interactive = new InteractiveService(advanced,vscode.Uri.joinPath(context.globalStorageUri,'rebase-jobs').fsPath,{node:process.execPath,helper:vscode.Uri.joinPath(context.extensionUri,'media','helpers','rebase-editor.cjs').fsPath},
      workspaceRebaseJournal(context.workspaceState));
    advanced.setEditorJobs(interactive);
    const planner=new RebasePlanner(context);context.subscriptions.push(planner);
    const advancedCommands = new AdvancedCommands(advanced,revisions,interactive,planner,context.extensionUri);
    const fileActions = new FileActionsCommands(advanced,revisions);
    const tools = new ToolsService(advanced);
    const toolsProvider = new ToolsProvider(tools);
    context.subscriptions.push(toolsProvider,vscode.window.createTreeView('gitPro.toolsView',{treeDataProvider:toolsProvider}));
    const history = new HistoryService(registry, executor, policy);
    const toolsCommands = new ToolsCommands(tools,new WorktreeService(tools,policy),history,revisions);
    const historyPanels = new HistoryPanel(context, history, revisions);
    const blame = new BlameController(history, registry,(id,oid)=>historyPanels.open(id,undefined,oid,true));
    const historyCodeLens = new HistoryCodeLens(registry, policy);
    context.subscriptions.push(historyCodeLens, vscode.languages.registerCodeLensProvider({scheme:'file'}, historyCodeLens));
    const daily = new DailyCommands(git, revisions, adapter, changesPanel, logger);
    const branches = new BranchesProvider(git);
    const composer = new CommitComposer(context, git, (id, message, options, push) => daily.commit(id, message, options, push),logger);
    const lifetime = new AbortController();
    context.subscriptions.push({ dispose: () => lifetime.abort() }, executor, store, registry, coordinator,
      providers.repositories, providers.changes, statusbar,
      vscode.window.createTreeView('gitPro.repositories', { treeDataProvider: providers.repositories }),
      changesPanel, vscode.window.registerWebviewViewProvider('gitPro.changes',changesPanel,{webviewOptions:{retainContextWhenHidden:false}}),
      revisions, daily, branches, composer, autoFetch, history, historyPanels, blame,
      vscode.workspace.registerTextDocumentContentProvider('git-pro-revision', revisions),
      vscode.window.createTreeView('gitPro.branchesView', { treeDataProvider: branches }),
      vscode.window.registerWebviewViewProvider('gitPro.commitView', composer));
    const command = (id: string, action: (...args: unknown[]) => Promise<unknown>) => {
      context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try { policy.checkTrust(); if (!adapter.enabled) throw new Error('Enable the built-in Git extension first.'); return await action(...args); }
        catch (error) { const recovery=recoveryFor(error);logger.error(recovery.diagnostic);const choice=await vscode.window.showErrorMessage(`Git Pro: ${recovery.message}`,recovery.label);if(choice===recovery.label)await vscode.commands.executeCommand(recovery.command); }
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
      const configuration = vscode.workspace.getConfiguration('gitPro');
      await configuration.update('blame.enabled', !configuration.get('blame.enabled', false), vscode.ConfigurationTarget.Workspace);
    });
    command('gitPro.openBlameCommit',async()=>blame.openCurrentCommit());
    command('gitPro.fileHistory', async uri => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
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
    command('gitPro.openFile', async (id, relative) => {
      if (typeof id !== 'string' || typeof relative !== 'string') throw new Error('Select a changed file from Git Pro.');
      const repo = registry.list().find(item => item.id === id);
      if (!repo) throw new Error('Repository is no longer open.');
      const file = await policy.authorizeFile(repo.root, relative);
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
    });
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
      for (const root of await discoverRepositories(roots(), policy, { signal: lifetime.signal })) {
        if (lifetime.signal.aborted) break;
        await adapter.open(root);
      }
      await synchronize();
    } catch (error) { logger.error(String(error)); }
    logger.info(`Foundation ready: ${registry.list().length} repositories.`);
    const countFiles=(nodes:readonly ChangeNode[]):number=>nodes.reduce((count,node)=>count+(node.kind==='file'?1:node.kind==='group'||node.kind==='folder'?countFiles(providers.changes.getChildren(node)):0),0);
    return {
      repositories: () => registry.list().length, activeRepository: () => registry.active?.id,
      capabilities: () => adapter.capabilities(), activeSnapshot: () => registry.active ? store.get(registry.active.id) : undefined,
      historyPanelCount:()=>historyPanels.activePanelCount,
      changesViewResolved:()=>changesPanel.isResolved,
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
