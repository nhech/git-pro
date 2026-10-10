import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
/** No repository paths or revision expressions are accepted from URI query data. */
export class RevisionProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private bytes = 0;
  add(content: Buffer, label: string): vscode.Uri {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    if (content.includes(0) || content.length > 5 * 1024 * 1024) throw new Error('Unsupported text revision.');
    while (this.contents.size >= 64 || this.bytes + content.length > 32 * 1024 * 1024) {
      const first = this.contents.entries().next().value;
      if (!first) break;
      this.bytes -= Buffer.byteLength(first[1]); this.contents.delete(first[0]);
    }
    const id = randomUUID(); this.contents.set(id, text); this.bytes += content.length;
    return vscode.Uri.from({ scheme: 'git-pro-revision', path: `/${id}/${label.split(/[\\/]/).at(-1) ?? 'revision.txt'}` });
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    const id = uri.path.split('/')[1] ?? '';
    const content = this.contents.get(id);
    if (content === undefined) throw new Error('Revision snapshot expired. Reopen the diff.'); return content;
  }
  dispose(): void { this.contents.clear(); this.bytes = 0; }
}
