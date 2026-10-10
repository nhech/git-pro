import * as vscode from 'vscode';
import * as path from 'node:path';
import { lstat } from 'node:fs/promises';
import type { RepositoryRegistry } from '../repositories/repository-registry';
import { canonicalFilePath, type PathPolicy } from '../security/paths';
import { Emitter } from '../utils/events';

/** One optional discovery entry; no Git/content read or mutable action. */
export class HistoryCodeLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new Emitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];
  private generation = 0;
  private disposed = false;
  constructor(private readonly registry: RepositoryRegistry, private readonly policy: PathPolicy) {
    const refresh = () => { if (!this.disposed) { this.generation++; this.changed.fire(); } };
    this.subscriptions = [registry.onDidChange(refresh),
      vscode.workspace.onDidChangeTextDocument(refresh),
      vscode.workspace.onDidCloseTextDocument(refresh),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('gitPro.codeLens')) refresh(); })];
  }
  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    const generation = this.generation, version = document.version;
    const valid = () => !this.disposed && generation === this.generation && !token.isCancellationRequested &&
      vscode.workspace.isTrusted && !document.isClosed && !document.isDirty && document.version === version &&
      document.uri.scheme === 'file' && vscode.workspace.getConfiguration('gitPro', document.uri).get<boolean>('codeLens.enabled', false) === true;
    if (!valid()) return [];
    try {
      this.policy.checkTrust();
      const info = await lstat(document.uri.fsPath);
      if (!info.isFile() || info.isSymbolicLink() || !valid()) return [];
      const repo = await this.registry.resolveFile(document.uri.fsPath);
      if (!repo || !valid()) return [];
      const canonical = await canonicalFilePath(document.uri.fsPath);
      const relative = path.relative(repo.root, canonical).replace(/\\/g, '/');
      await this.policy.authorizeFile(repo.root, relative);
      this.policy.checkTrust();
      if (!valid() || !this.registry.list().includes(repo)) return [];
      return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: 'Git Pro: File History', command: 'gitPro.fileHistory', arguments: [document.uri],
        tooltip: 'Review saved-file commit history. This does not change Git state.',
      })];
    } catch { return []; }
  }
  dispose(): void {
    this.disposed = true; this.generation++;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}
