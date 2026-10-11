import * as vscode from 'vscode';
import * as path from 'node:path';
import type { FeatureDeps, TrustedCommand } from '../conflicts/surfaces';
import type { ConflictSource, OperationControlAction, OperationSummary, OperationSummaryProvider } from '../git/conflicts/conflict-contract';
import type { RepositoryDescriptor, RepositoryRegistry } from '../repositories/repository-registry';
import { OperationContext } from '../git/conflicts/operation-context';
import { ConflictWatcher } from '../conflicts/conflict-watcher';
import { conflictCount, continueLabel, controllable, nativeOnly, operationNoun, operationStatus, skipLabel } from '../conflicts/operation-text';
import { redact } from '../security/redaction';
import { confirmAndControl } from './advanced.commands';

/**
 * One summary per status snapshot and recorded source: the status bar, the Changes banner and the operation menu all ask on every refresh, and each
 * summary costs a status read plus the ref and subject reads behind the branch names. A failed summary is not kept, so the next refresh retries.
 */
export function cachedSummaries(registry: Pick<RepositoryRegistry, 'store'>, sources: ReadonlyMap<string, ConflictSource>, provider: OperationSummaryProvider): OperationSummaryProvider {
  const cache = new WeakMap<object, { readonly source: ConflictSource | undefined; readonly value: Promise<OperationSummary> }>();
  return { summary: (id, signal) => {
    const snapshot = registry.store.get(id), source = sources.get(id);
    // A caller's own signal must not cancel a summary the others share.
    if (!snapshot || signal) return provider.summary(id, signal);
    const hit = cache.get(snapshot); if (hit && hit.source === source) return hit.value;
    const value = provider.summary(id); cache.set(snapshot, { source, value });
    value.catch(() => { if (cache.get(snapshot)?.value === value) cache.delete(snapshot); });
    return value;
  } };
}

/** §3.4: the operation menu and Continue / Abort / Skip, every one through WP1's confirmAndControl modals; plus the conflict watcher and the summary provider. */
export function registerOperation(context: vscode.ExtensionContext, deps: FeatureDeps, command: TrustedCommand): void {
  const { registry, advanced, surfaces } = deps;
  surfaces.operation = cachedSummaries(registry, surfaces.conflictSources, new OperationContext(advanced, surfaces.conflictSources));
  context.subscriptions.push(new ConflictWatcher(registry, surfaces, deps.logger));
  /** Commands from the banner and the toast name their repository; the palette and the status bar act on the active one. */
  const target = (arg: unknown): RepositoryDescriptor => {
    if (typeof arg === 'string') { const repo = registry.list().find(item => item.id === arg); if (!repo) throw new Error('Repository is no longer open.'); return repo; }
    const repo = registry.active; if (!repo) throw new Error('Select a repository first.'); return repo;
  };
  const openConflicts = async (id: string): Promise<void> => { if (surfaces.conflicts) await surfaces.conflicts.open(id); else await vscode.commands.executeCommand('gitPro.conflicts.open'); };
  const control = async (action: OperationControlAction, arg: unknown): Promise<boolean> => {
    const repo = target(arg), snapshot = await advanced.snapshot(repo.id);
    if (!controllable(snapshot.operation)) {
      if (snapshot.operation === 'idle') throw new Error('No merge, rebase, cherry-pick or revert is in progress.');
      await vscode.window.showInformationMessage(`Git Pro: ${operationNoun(snapshot.operation)} in progress. Use native Git to finish it.`); return false;
    }
    if (action === 'skip' && snapshot.operation === 'merging') throw new Error('A merge has no commit to skip. Continue or abort it.');
    const conflicts = snapshot.status.changes.filter(change => change.group === 'conflicts').length;
    // Continue would only be refused (§3.13, invariant 5): point to the files instead of a Git error.
    if (action === 'continue' && conflicts) {
      if (await vscode.window.showWarningMessage(`Git Pro: ${conflictCount(conflicts)} ${conflicts === 1 ? 'remains' : 'remain'}. Resolve and stage ${conflicts === 1 ? 'it' : 'them'} before continuing.`, 'Resolve Conflicts…') === 'Resolve Conflicts…') await openConflicts(repo.id);
      return false;
    }
    return confirmAndControl(advanced, snapshot, action);
  };
  const menu = async (): Promise<void> => {
    const repo = target(undefined), snapshot = registry.store.get(repo.id), operation = snapshot?.operation ?? 'idle', conflicts = snapshot?.changes.filter(change => change.group === 'conflicts').length ?? 0;
    let summary: OperationSummary | undefined;
    try { summary = await surfaces.operation?.summary(repo.id); } catch { summary = undefined; }
    const items: (vscode.QuickPickItem & { run: () => Promise<unknown> })[] = [];
    if (conflicts || controllable(operation)) items.push({ label: '$(list-unordered) Open Conflicts', description: conflicts ? conflictCount(conflicts) : 'All conflicts resolved', run: () => openConflicts(repo.id) });
    if (controllable(operation)) {
      const noun = operationNoun(operation).toLowerCase();
      items.push({ label: `$(debug-continue) ${continueLabel(operation)}`, description: conflicts ? 'Resolve and stage all conflicts first' : operation === 'merging' ? 'Commit the merge; asks first' : `Continue the ${noun}; asks first`, run: () => control('continue', repo.id) });
      if (operation !== 'merging') items.push({ label: `$(debug-step-over) ${skipLabel(operation)}`, description: operation === 'rebasing' ? 'Drop the commit being replayed; asks first' : 'Skip the current commit; asks first', run: () => control('skip', repo.id) });
      items.push({ label: '$(circle-slash) Abort…', description: `Return to the state before the ${noun}; asks first`, run: () => control('abort', repo.id) });
    } else if (nativeOnly(operation, summary)) items.push({ label: '$(source-control) Open Source Control', description: 'Finish this operation in native Git', run: () => Promise.resolve(vscode.commands.executeCommand('workbench.view.scm')) });
    items.push({ label: '$(repo) Select Repository', description: redact(path.basename(repo.root)), run: () => Promise.resolve(vscode.commands.executeCommand('gitPro.selectRepository')) });
    const picked = await vscode.window.showQuickPick(items, { title: redact(`Git Pro: ${operationStatus(operation, conflicts, summary)}`), placeHolder: controllable(operation) ? 'Resolve conflicts, then continue; every action asks before it changes anything' : 'Choose an action' });
    if (picked) await picked.run();
  };
  command('gitPro.operation.menu', () => menu());
  command('gitPro.operation.continue', arg => control('continue', arg));
  command('gitPro.operation.abort', arg => control('abort', arg));
  command('gitPro.operation.skip', arg => control('skip', arg));
}
