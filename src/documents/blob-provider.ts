import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { validateOid } from '../security/refs';
import { historyPath } from '../git/history/history-builders';
import type { HistoryService } from '../git/history/history.service';

interface BlobToken { readonly repositoryId: string; readonly oid: string; readonly path: string }
/**
 * Lazy `git-pro-blob:/<uuid>/<basename>` sides for the multi-diff editor (design N8). The URI carries no path, revision or query: a token maps in memory
 * to a repository, a pinned commit and a path, and the content is read only when VS Code opens that side, through HistoryService.revision and all its bounds.
 */
export class BlobProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = 'git-pro-blob';
  private readonly tokens = new Map<string, BlobToken>();
  private readonly identities = new Map<string, string>();
  constructor(private readonly history: Pick<HistoryService, 'revision'>, private readonly capacity = 4096) {}
  get size(): number { return this.tokens.size; }
  add(repositoryId: string, oid: string, file: string): vscode.Uri {
    validateOid(oid); historyPath(file);
    if (typeof repositoryId !== 'string' || !repositoryId || repositoryId.length > 4096) throw new Error('Invalid blob repository.');
    const identity = JSON.stringify([repositoryId, oid, file]);
    let id = this.identities.get(identity);
    // Least recently used first: reusing a side moves it to the end, so a reopened comparison keeps its tokens.
    if (id) { const token = this.tokens.get(id)!; this.tokens.delete(id); this.tokens.set(id, token); }
    else {
      while (this.tokens.size >= this.capacity) {
        const oldest = this.tokens.entries().next().value; if (!oldest) break;
        this.tokens.delete(oldest[0]); this.identities.delete(JSON.stringify([oldest[1].repositoryId, oldest[1].oid, oldest[1].path]));
      }
      id = randomUUID(); this.tokens.set(id, Object.freeze({ repositoryId, oid, path: file })); this.identities.set(identity, id);
    }
    return vscode.Uri.from({ scheme: BlobProvider.scheme, path: `/${id}/${file.split('/').at(-1) || 'revision.txt'}` });
  }
  async provideTextDocumentContent(uri: vscode.Uri, cancellation?: vscode.CancellationToken): Promise<string> {
    const id = uri.path.split('/')[1] ?? '', token = uri.scheme === BlobProvider.scheme && !uri.query && !uri.fragment ? this.tokens.get(id) : undefined;
    if (!token) throw new Error('Comparison side expired. Open All Changes again from the Compare tab.');
    const controller = new AbortController(), subscription = cancellation?.onCancellationRequested(() => controller.abort());
    try { return new TextDecoder('utf-8', { fatal: true }).decode(await this.history.revision(token.repositoryId, token.oid, token.path, controller.signal)); }
    finally { subscription?.dispose(); }
  }
  dispose(): void { this.tokens.clear(); this.identities.clear(); }
}
