import * as vscode from 'vscode';
import type { FeatureDeps, TrustedCommand } from '../conflicts/surfaces';
import type { AdvancedCommands } from './advanced.commands';
import { describeAge, type DiscardEntry, type PushEntry, type ResetEntry, type UndoEntry } from '../git/undo/undo.service';
import { redact } from '../security/redaction';

type UndoDeps = Pick<FeatureDeps, 'registry' | 'git' | 'undo'>;
const shown = 20;

/** What a toast or a status bar message asks for: the copy of one repository. Anything else is an invitation to choose. */
function parseRequest(argument: unknown): { readonly repositoryId: string; readonly id: string } | undefined {
  if (!argument || typeof argument !== 'object') return undefined;
  const { repositoryId, id } = argument as { repositoryId?: unknown; id?: unknown };
  return typeof repositoryId === 'string' && repositoryId.length <= 4096 && typeof id === 'string' && id.length <= 64 ? { repositoryId, id } : undefined;
}

/**
 * Git Pro: Undo… brings back what Git Pro was about to throw away, from the copies it keeps (see undo.service.ts): the unstaged changes of files a Discard reset, the changes and the HEAD of a hard
 * reset, the commit a force push replaced. Each restore goes through the same review as the action it undoes, and keeps a copy of what it replaces in turn.
 */
export class UndoCommands {
  constructor(private readonly deps: UndoDeps, private readonly advanced: AdvancedCommands, private readonly now: () => number = Date.now) {}
  async undo(argument: unknown): Promise<void> {
    const request = parseRequest(argument), repo = request ? this.deps.registry.list().find(item => item.id === request.repositoryId) : this.deps.registry.active;
    if (request && !repo) throw new Error('Repository is no longer open.');
    if (!repo) throw new Error('Select a repository first.');
    const entries = this.deps.undo.list(repo.id);
    if (!entries.length) { await vscode.window.showInformationMessage('Nothing to undo. Git Pro keeps a copy of what it is about to lose when you discard changes, hard reset or force push.'); return; }
    let entry: UndoEntry | undefined;
    if (request) { entry = entries.find(item => item.id === request.id); if (!entry) throw new Error('Git Pro no longer keeps that copy.'); }
    else {
      const picked = await vscode.window.showQuickPick(entries.slice(0, shown).map(item => ({ label: redact(item.label), description: describeAge(item.time, this.now()), detail: this.detail(item), entry: item })),
        { title: 'Git Pro: Undo…', placeHolder: 'What to bring back', matchOnDetail: true });
      if (!picked) return;
      if (!this.deps.registry.list().some(item => item.id === repo.id)) throw new Error('Repository is no longer open.');
      entry = picked.entry;
    }
    if (entry.kind === 'discard') await this.restoreDiscard(repo.id, entry);
    else if (entry.kind === 'reset') await this.restoreReset(repo.id, entry);
    else await this.restorePush(repo.id, entry);
  }
  private detail(entry: UndoEntry): string {
    if (entry.kind === 'discard') return redact(entry.paths.length > 3 ? `${entry.paths.slice(0, 3).join(', ')} and ${entry.paths.length - 3} more` : entry.paths.join(', '));
    if (entry.kind === 'reset') return `HEAD was ${entry.head.slice(0, 10)}${entry.snapshot ? ' · uncommitted changes saved' : ' · no uncommitted changes to save'}`;
    return redact(`${entry.remote}/${entry.branch} was ${entry.oldTip.slice(0, 10)}, now ${entry.newTip.slice(0, 10)}`);
  }
  private root(id: string): string { return this.deps.git.repository(id).root; }
  private async restoreDiscard(id: string, entry: DiscardEntry): Promise<void> {
    const root = this.root(id);
    if (!await this.deps.undo.holds(root, entry.snapshot)) throw new Error('Git no longer has the saved copy of these files.');
    const status = await this.deps.git.state(id);
    // Edits made to a file since it was discarded are the only thing a restore can lose, and are what the review names.
    const edited = entry.paths.filter(file => status.changes.some(change => change.path === file && (change.group === 'working' || change.group === 'conflicts')));
    const list = entry.paths.slice(0, 20).join('\n') + (entry.paths.length > 20 ? `\n… and ${entry.paths.length - 20} more` : '');
    const warning = edited.length ? `\n\nThese have changed since and will be replaced:\n${edited.slice(0, 20).join('\n')}${edited.length > 20 ? `\n… and ${edited.length - 20} more` : ''}` : '';
    if (await vscode.window.showWarningMessage(`Restore ${entry.paths.length === 1 ? redact(entry.paths[0]!) : `${entry.paths.length} files`} as they were before they were discarded?`, { modal: true, detail: redact(`${root}\n${list}${warning}`) }, 'Restore') !== 'Restore') return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Git Pro: Undo' }, async () => this.deps.git.restoreFromSource(await this.deps.git.preview(id, [...entry.paths]), entry.snapshot));
    await this.deps.undo.remove(id, root, entry.id);
    vscode.window.setStatusBarMessage(`Git Pro: restored ${entry.paths.length === 1 ? redact(entry.paths[0]!) : `${entry.paths.length} files`}.`, 10000);
  }
  private async restoreReset(id: string, entry: ResetEntry): Promise<void> {
    const root = this.root(id);
    const note = `Undo: ${entry.label}.${entry.snapshot ? ' The changes to tracked files that were saved before it are applied again afterwards.' : ''}`;
    // The reset back to the old HEAD is reviewed like any hard reset, and keeps a copy of what it replaces, so it can be undone too.
    if (!await this.advanced.review(id, { kind: 'reset', oid: entry.head, mode: 'hard' }, 'Reset', { note, quiet: true })) return;
    if (entry.snapshot) {
      try { await this.deps.git.applySafetyCopy(id, entry.snapshot); }
      catch (error) { throw new Error(`HEAD is back at ${entry.head.slice(0, 10)}, but the saved changes could not be applied (${error instanceof Error ? redact(error.message) : 'unknown error'}). Git still has them: run git stash apply ${entry.snapshot} to try again.`); }
    }
    await this.deps.undo.remove(id, root, entry.id);
    vscode.window.setStatusBarMessage(`Git Pro: HEAD is back at ${entry.head.slice(0, 10)}.`, 10000);
  }
  private async restorePush(id: string, entry: PushEntry): Promise<void> {
    if (!await this.advanced.restorePush(id, entry)) return;
    await this.deps.undo.remove(id, this.root(id), entry.id);
    vscode.window.setStatusBarMessage(`Git Pro: ${redact(entry.branch)} on ${redact(entry.remote)} is back at ${entry.oldTip.slice(0, 10)}.`, 10000);
  }
}

/** Git Pro: Undo… through the trusted wrapper. */
export function registerUndo(deps: FeatureDeps, command: TrustedCommand, advanced: AdvancedCommands): void {
  const commands = new UndoCommands(deps, advanced);
  command('gitPro.undo', argument => commands.undo(argument));
}
