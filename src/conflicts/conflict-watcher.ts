import * as vscode from 'vscode';
import * as path from 'node:path';
import type { RepositoryDescriptor, RepositoryRegistry } from '../repositories/repository-registry';
import type { RepositorySnapshot } from '../state/repository-store';
import type { GitOperation } from '../state/operation-state';
import type { Logger } from '../utils/logging';
import { redact } from '../security/redaction';
import { conflictsAutoOpen, type Surfaces } from './surfaces';
import { continueLabel, controllable } from './operation-text';

/** N9: `gitPro.conflictResources` holds at most this many current conflicts across the open repositories. */
export const MAX_CONFLICT_RESOURCES = 500;

/**
 * Keeps the conflict context keys of §3.19 current, opens the Conflicts tab in the background for `always` (§3.5) and says when an operation's last
 * conflict is resolved. It only reveals UI and never mutates (N10). Native Complete Merge belongs to the merge-editor bridge, not here.
 */
export class ConflictWatcher implements vscode.Disposable {
  /** Last count per repository; a repository first seen with conflicts (startup, a newly opened folder) is not a transition. */
  private readonly seen = new Map<string, { readonly count: number; readonly operation: GitOperation }>();
  private readonly paths = new WeakMap<RepositorySnapshot, readonly string[]>();
  private inputs: readonly (readonly [RepositoryDescriptor, RepositorySnapshot | undefined])[] = [];
  private readonly context = new Map<string, string>();
  private readonly subscription: { dispose(): void };
  constructor(private readonly registry: RepositoryRegistry, private readonly surfaces: Surfaces, private readonly logger?: Logger) {
    this.subscription = registry.onDidChange(() => this.update());
    this.update();
  }
  private conflicts(snapshot: RepositorySnapshot): readonly string[] {
    let found = this.paths.get(snapshot);
    if (!found) { found = snapshot.changes.filter(change => change.group === 'conflicts').map(change => change.path); this.paths.set(snapshot, found); }
    return found;
  }
  private update(): void {
    const active = this.registry.active, repos = this.registry.list();
    // The active repository first, so the cap keeps the files the Changes view shows.
    const inputs = (active ? [active, ...repos.filter(repo => repo !== active)] : repos).map(repo => [repo, this.registry.store.get(repo.id)] as const);
    // Registry events also fire for selection and errors; nothing here changes unless a snapshot or the order does.
    if (inputs.length === this.inputs.length && inputs.every((item, index) => item[0] === this.inputs[index]![0] && item[1] === this.inputs[index]![1])) return;
    this.inputs = inputs;
    const resources: vscode.Uri[] = [];
    for (const [repo, snapshot] of inputs) {
      if (!snapshot) continue;
      const files = this.conflicts(snapshot);
      for (const file of files) { if (resources.length >= MAX_CONFLICT_RESOURCES) break; resources.push(vscode.Uri.file(path.join(repo.root, file))); }
      const previous = this.seen.get(repo.id);
      this.seen.set(repo.id, { count: files.length, operation: snapshot.operation });
      if (previous) this.transition(repo, previous, files.length, snapshot.operation, repo === active);
    }
    for (const id of [...this.seen.keys()]) if (!repos.some(repo => repo.id === id)) { this.seen.delete(id); this.surfaces.conflictSources.delete(id); }
    const snapshot = active ? this.registry.store.get(active.id) : undefined, operation = snapshot?.operation ?? 'idle', hasConflicts = snapshot ? this.conflicts(snapshot).length > 0 : false;
    this.set('gitPro.operation', operation, operation);
    this.set('gitPro.hasConflicts', hasConflicts, String(hasConflicts));
    // Uri objects, as built-in Git sets git.mergeChanges: the workbench compares them as strings with `resource` and `mergeEditorResultUri`.
    this.set('gitPro.conflictResources', resources, resources.map(uri => uri.toString()).join('\n'));
  }
  private set(key: string, value: unknown, identity: string): void {
    if (this.context.get(key) === identity) return;
    this.context.set(key, identity);
    void Promise.resolve(vscode.commands.executeCommand('setContext', key, value)).catch((error: unknown) => { this.context.delete(key); this.logger?.error(redact(`Could not set ${key}: ${error instanceof Error ? error.message : String(error)}`)); });
  }
  private transition(repo: RepositoryDescriptor, previous: { readonly count: number; readonly operation: GitOperation }, count: number, operation: GitOperation, active: boolean): void {
    // `always` (§3.5): conflicts that appeared outside Git Pro, for example a terminal merge, open the tab without taking focus.
    if (previous.count < 1 && count > 0 && active && this.surfaces.conflicts && conflictsAutoOpen(vscode.workspace.getConfiguration('gitPro', vscode.Uri.file(repo.root)).get('conflicts.autoOpen')) === 'always')
      void this.surfaces.conflicts.open(repo.id, { preserveFocus: true }).catch((error: unknown) => this.logger?.error(redact(`Could not open Conflicts: ${error instanceof Error ? error.message : String(error)}`)));
    if (previous.count < 1 || count > 0) return;
    // The recorded stash or squash source describes these conflicts only.
    this.surfaces.conflictSources.delete(repo.id);
    if (controllable(operation) && previous.operation === operation) void this.resolved(repo, operation);
  }
  private async resolved(repo: RepositoryDescriptor, operation: 'merging' | 'rebasing' | 'cherry-picking' | 'reverting'): Promise<void> {
    const label = continueLabel(operation), where = this.registry.list().length > 1 ? ` in ${path.basename(repo.root)}` : '';
    try {
      // Continue only navigates to the operation command, which confirms before it changes anything.
      if (await vscode.window.showInformationMessage(redact(`Git Pro: All conflicts resolved${where}.`), label) === label) await vscode.commands.executeCommand('gitPro.operation.continue', repo.id);
    } catch (error) { this.logger?.error(redact(`Could not offer Continue: ${error instanceof Error ? error.message : String(error)}`)); }
  }
  dispose(): void { this.subscription.dispose(); this.seen.clear(); this.context.clear(); this.inputs = []; }
}
