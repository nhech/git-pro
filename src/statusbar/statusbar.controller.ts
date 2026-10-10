import * as vscode from 'vscode';
import * as path from 'node:path';
import type { RepositoryRegistry } from '../repositories/repository-registry';
import { redact } from '../security/redaction';
export class StatusbarController implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  private readonly subscriptions: { dispose(): void }[];
  constructor(private readonly registry: RepositoryRegistry, private readonly lastFetched: (id: string) => number | undefined = () => undefined,
    onDidFetch?: (listener: () => void) => { dispose(): void }) {
    this.item.name = 'Git Pro'; this.item.command = 'gitPro.selectRepository';
    // A fetch that brings nothing new leaves status unchanged, so it needs its own signal to update the tooltip.
    this.subscriptions = [registry.onDidChange(() => this.update()), ...(onDidFetch ? [onDidFetch(() => this.update())] : [])];
    this.update();
  }
  private update(): void {
    const repo = this.registry.active;
    if (!repo) { this.item.hide(); return; }
    const snapshot = this.registry.store.get(repo.id);
    const arrows = snapshot?.upstream ? ` ↑${snapshot.ahead ?? '?'} ↓${snapshot.behind ?? '?'}` : '';
    const operation = snapshot && snapshot.operation !== 'idle' ? ` ${snapshot.operation.toUpperCase()}` : '';
    this.item.text = redact(`$(git-branch) ${snapshot?.head ?? 'Unborn'}${arrows}${operation}`);
    const fetched = this.lastFetched(repo.id);
    this.item.tooltip = redact(`${path.basename(repo.root)}\n${snapshot?.upstream ? `Outgoing/incoming relative to ${snapshot.upstream}; local refs only.` : 'No upstream configured.'}\n${fetched ? `Last fetch ${new Date(fetched).toLocaleTimeString()}` : 'No fetch in this session.'}\n${snapshot ? `Status last changed ${new Date(snapshot.refreshedAt).toLocaleTimeString()}` : 'Loading…'}`);
    this.item.show();
  }
  dispose(): void { for (const subscription of this.subscriptions) subscription.dispose(); this.item.dispose(); }
}
