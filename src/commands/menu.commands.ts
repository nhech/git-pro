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
export function registerMenus(_context: vscode.ExtensionContext, deps: FeatureDeps, command: TrustedCommand, flows: { readonly advanced: AdvancedCommands; readonly tools: ToolsCommands }): void {
  const menus = deps.surfaces.menus;
  const onCommit = (name: string, run: (repositoryId: string, oid: string) => Promise<unknown>) =>
    command(`gitPro.menu.commit.${name}`, async argument => { const { repositoryId, oid } = menus.commit(argument, commitWebviews); await run(repositoryId, oid); });
  // Menu commands that belong to one panel: the panel checks the rest (its revision, the rows it showed) before it acts.
  const onPanel = (webview: string, section: string, name: string) =>
    command(`gitPro.menu.${webview}.${name}`, async argument => { const { panel, context } = menus.resolve(argument, [`gitPro.${webview}`], section); await panel.handle?.(name, context); });
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
  // The Repository Tools view's own menu, and the Repositories view's.
  for (const [name, preset] of toolMenus) command(`gitPro.tools.${name}`, node => flows.tools.menu(node, preset));
  const repository = (node: unknown) => {
    const id = node && typeof node === 'object' ? (node as { id?: unknown }).id : undefined, found = typeof id === 'string' ? deps.registry.list().find(item => item.id === id) : undefined;
    if (!found) throw new Error('Select a repository in the Repositories view.');
    return found;
  };
  for (const [name, target] of [['history', 'gitPro.history'], ['fetch', 'gitPro.fetch'], ['pull', 'gitPro.pull'], ['push', 'gitPro.push'], ['tools', 'gitPro.repositoryTools']] as const)
    command(`gitPro.repository.${name}`, async node => { deps.registry.select(repository(node).id); await vscode.commands.executeCommand(target); });
  command('gitPro.repository.copyPath', async node => { await vscode.env.clipboard.writeText(repository(node).root); });
  command('gitPro.repository.reveal', async node => { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(repository(node).root)); });
  for (const name of ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop', 'moveUp', 'moveDown', 'editMessage']) onPanel('rebasePlanner', 'step', name);
  for (const name of ['merge', 'acceptYours', 'acceptTheirs', 'markResolved', 'openFile', 'compareBaseYours', 'compareBaseTheirs', 'compareYoursTheirs']) onPanel('conflicts', 'conflict', name);
}
