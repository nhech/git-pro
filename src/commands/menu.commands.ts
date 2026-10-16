import * as vscode from 'vscode';
import type { FeatureDeps, TrustedCommand } from '../conflicts/surfaces';
import type { AdvancedCommands } from './advanced.commands';
import type { ToolsCommands } from './tools.commands';
import { toolMenus } from '../views/tools/tool-menus';

/** Panels whose rows are commits: the commit menu below is the same in History and in the Compare tab. */
export const commitWebviews: readonly string[] = ['gitPro.history', 'gitPro.compare'];

/**
 * The commands behind the native context menus of the webview panels (`contributes.menus["webview/context"]`). Each takes the object VS Code passes from the
 * clicked element (see menu-context.ts), never trusts it, and reuses the reviewed flows that Advanced Actions, Repository Tools and Compare already have, so a
 * commit chosen from a menu goes through the same preview and confirmation as one typed into a prompt.
 */
export function registerMenus(_context: vscode.ExtensionContext, deps: FeatureDeps, command: TrustedCommand, flows: { readonly advanced: AdvancedCommands; readonly tools: ToolsCommands; /** The item selected in the Repository Tools view, for a command run from its keyboard shortcut. */ readonly selectedTool?: () => unknown }): void {
  const menus = deps.surfaces.menus;
  const onCommit = (name: string, run: (repositoryId: string, oid: string) => Promise<unknown>) =>
    command(`gitPro.menu.commit.${name}`, async argument => { const { repositoryId, oid } = menus.commit(argument, commitWebviews); await run(repositoryId, oid); });
  // Menu commands that belong to one panel: the panel checks the rest (its revision, the rows it showed) before it acts. With `keyboard`, a shortcut may run the command: it carries no
  // context, so it acts on the panel that is the active editor and on what that panel has selected.
  const onPanel = (webview: string, section: string, name: string, keyboard = false) =>
    command(`gitPro.menu.${webview}.${name}`, async argument => {
      if (keyboard && argument === undefined) { await menus.active(`gitPro.${webview}`).handle?.(name); return; }
      const { panel, context } = menus.resolve(argument, [`gitPro.${webview}`], section); await panel.handle?.(name, context);
    });
  const compare = () => { const surface = deps.surfaces.compare; if (!surface) throw new Error('The Compare tab is still starting. Try again.'); return surface; };
  onCommit('checkoutDetached', (id, oid) => flows.tools.checkoutCommit(id, oid));
  onCommit('createBranch', (id, oid) => flows.tools.branchFromCommit(id, oid));
  onCommit('createTag', (id, oid) => flows.tools.tagAtCommit(id, oid));
  onCommit('cherryPick', (id, oid) => flows.advanced.applyCommit(id, 'cherryPick', oid));
  onCommit('revert', (id, oid) => flows.advanced.applyCommit(id, 'revert', oid));
  onCommit('rebaseFromHere', (id, oid) => flows.advanced.rebasePlan({ repositoryId: id, base: `${oid}~1` }));
  onCommit('compareWithCurrent', (id, oid) => compare().openRefs(id, oid, 'HEAD'));
  onCommit('compareWithWorkingTree', (id, oid) => compare().openWorktree(id, oid));
  onCommit('copyHash', async (_id, oid) => { await vscode.env.clipboard.writeText(oid); });
  onCommit('copyMessage', async (id, oid) => { await vscode.env.clipboard.writeText(await deps.history.message(id, oid)); });
  for (const name of ['showFiles', 'showInHistory']) onPanel('compare', 'commit', name);
  for (const name of ['diff', 'localDiff', 'openFile', 'getFromBranch', 'copyPath']) onPanel('compare', 'file', name);
  // The Changes view's own menu: a group row stages or unstages all of its files, and the view title switches between a list and a tree.
  command('gitPro.stageGroup', async node => { await vscode.commands.executeCommand('gitPro.stage', node); });
  command('gitPro.unstageGroup', async node => { await vscode.commands.executeCommand('gitPro.unstage', node); });
  const group = async (mode: 'status' | 'folder') => {
    const repo = deps.registry.active, config = vscode.workspace.getConfiguration('gitPro', repo ? vscode.Uri.file(repo.root) : undefined), inspected = config.inspect<string>('changes.groupBy');
    // Written where the effective value comes from, so the choice never leaves a workspace file that shadows nothing.
    await config.update('changes.groupBy', mode, inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
  };
  command('gitPro.changes.viewAsTree', () => group('folder'));
  command('gitPro.changes.viewAsList', () => group('status'));
  // The Repository Tools view's own menu, and the Repositories view's.
  for (const [name, preset] of toolMenus) command(`gitPro.tools.${name}`, node => flows.tools.menu(node ?? flows.selectedTool?.(), preset));
  const repository = (node: unknown) => {
    const id = node && typeof node === 'object' ? (node as { id?: unknown }).id : undefined, found = typeof id === 'string' ? deps.registry.list().find(item => item.id === id) : undefined;
    if (!found) throw new Error('Select a repository in the Repositories view.');
    return found;
  };
  for (const [name, target] of [['history', 'gitPro.history'], ['fetch', 'gitPro.fetch'], ['pull', 'gitPro.pull'], ['push', 'gitPro.push'], ['tools', 'gitPro.repositoryTools']] as const)
    command(`gitPro.repository.${name}`, async node => { deps.registry.select(repository(node).id); await vscode.commands.executeCommand(target); });
  command('gitPro.repository.copyPath', async node => { await vscode.env.clipboard.writeText(repository(node).root); });
  command('gitPro.repository.reveal', async node => { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(repository(node).root)); });
  for (const name of ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop', 'moveUp', 'moveDown', 'editMessage']) onPanel('rebasePlanner', 'step', name, true);
  for (const name of ['merge', 'acceptYours', 'acceptTheirs', 'markResolved', 'openFile', 'compareBaseYours', 'compareBaseTheirs', 'compareYoursTheirs']) onPanel('conflicts', 'conflict', name, true);
}
