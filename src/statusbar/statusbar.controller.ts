import * as vscode from 'vscode';
import * as path from 'node:path';
import type { RepositoryRegistry } from '../repositories/repository-registry';
import type { RepositorySnapshot } from '../state/repository-store';
import type { OperationSummary } from '../git/conflicts/conflict-contract';
import { redact } from '../security/redaction';
import { createSurfaces, type Surfaces } from '../conflicts/surfaces';
import { operationStatus } from '../conflicts/operation-text';
export class StatusbarController implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  private readonly subscriptions: { dispose(): void }[];
  /** Only the newest update may apply a summary that arrives later. */
  private generation = 0;
  constructor(private readonly registry: RepositoryRegistry, private readonly lastFetched: (id: string) => number | undefined = () => undefined,
    onDidFetch?: (listener: () => void) => { dispose(): void }, private readonly surfaces: Surfaces = createSurfaces()) {
    this.item.name = 'Git Pro'; this.item.command = 'gitPro.selectRepository';
    // A fetch that brings nothing new leaves status unchanged, so it needs its own signal to update the tooltip.
    this.subscriptions = [registry.onDidChange(() => this.update()), ...(onDidFetch ? [onDidFetch(() => this.update())] : [])];
    this.update();
  }
  private update(): void {
    const repo = this.registry.active, generation = ++this.generation;
    if (!repo) { this.item.hide(); return; }
    const snapshot = this.registry.store.get(repo.id);
    const arrows = snapshot?.upstream ? ` ↑${snapshot.ahead ?? '?'} ↓${snapshot.behind ?? '?'}` : '';
    const operation = snapshot && snapshot.operation !== 'idle' ? ` ${snapshot.operation.toUpperCase()}` : '';
    const conflicts = snapshot?.changes.filter(change => change.group === 'conflicts').length ?? 0;
    this.item.text = redact(`$(git-branch) ${snapshot?.head ?? 'Unborn'}${arrows}${operation}${conflicts ? ` $(warning) ${conflicts}` : ''}`);
    // During an operation or with conflicts the click offers Continue / Skip / Abort (§3.4); otherwise it keeps choosing a repository.
    const attention = Boolean(snapshot && (snapshot.operation !== 'idle' || conflicts));
    this.item.command = attention ? 'gitPro.operation.menu' : 'gitPro.selectRepository';
    this.item.tooltip = this.tooltip(repo.root, repo.id, snapshot, conflicts);
    // Screen readers hear the operation in words rather than "warning 3".
    this.item.accessibilityInformation = snapshot && attention ? { label: redact(`Git Pro: ${snapshot.head ?? 'Unborn'}, ${operationStatus(snapshot.operation, conflicts)}`) } : undefined;
    this.item.show();
    if (!attention || !snapshot) return;
    let pending: Promise<OperationSummary> | undefined;
    try { pending = this.surfaces.operation?.summary(repo.id); } catch { pending = undefined; }
    // The plain wording stays until the summary names the branches; a later refresh wins over an older summary.
    void pending?.then(summary => {
      if (generation !== this.generation || this.registry.active !== repo || this.registry.store.get(repo.id) !== snapshot) return;
      this.item.tooltip = this.tooltip(repo.root, repo.id, snapshot, conflicts, summary);
      this.item.accessibilityInformation = { label: redact(`Git Pro: ${snapshot.head ?? 'Unborn'}, ${operationStatus(snapshot.operation, conflicts, summary)}`) };
    }, () => undefined);
  }
  private tooltip(root: string, id: string, snapshot: RepositorySnapshot | undefined, conflicts: number, summary?: OperationSummary): string {
    const fetched = this.lastFetched(id);
    const operation = snapshot && (snapshot.operation !== 'idle' || conflicts) ? `${operationStatus(snapshot.operation, conflicts, summary)} · Click for actions\n` : '';
    return redact(`${operation}${path.basename(root)}\n${snapshot?.upstream ? `Outgoing/incoming relative to ${snapshot.upstream}; local refs only.` : 'No upstream configured.'}\n${fetched ? `Last fetch ${new Date(fetched).toLocaleTimeString()}` : 'No fetch in this session.'}\n${snapshot ? `Status last changed ${new Date(snapshot.refreshedAt).toLocaleTimeString()}` : 'Loading…'}`);
  }
  dispose(): void { for (const subscription of this.subscriptions) subscription.dispose(); this.item.dispose(); }
}
