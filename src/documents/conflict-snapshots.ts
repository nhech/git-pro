import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';

export const CONFLICT_SCHEME = 'git-pro-conflict';
/** N4/D6: merge-editor inputs as read-only text with the RevisionProvider rules (strict UTF-8, no NUL, 5 MiB), never `git:` URIs, which built-in Git reads with textconv. */
interface Entry { readonly text: string; readonly bytes: number }
export interface SnapshotLimits { readonly entries: number; readonly bytes: number }
/**
 * Bounded to 24 entries / 48 MiB. A set (base, Yours, Theirs) is added and pinned as one unit while its merge tab is open, so making room for one input can never
 * evict another input of the same editor; released sets stay readable until evicted. The URI path is `/<uuid>/<basename>`: no query data, no repository path.
 */
export class ConflictSnapshots implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  private readonly pins = new Map<string, readonly string[]>();
  private bytes = 0;
  constructor(private readonly limits: SnapshotLimits = { entries: 24, bytes: 48 * 1024 * 1024 }) {}
  get size(): number { return this.entries.size; }
  /** Replaces `owner`'s pinned set. Throws, adding nothing, when a content is not bounded text or the pinned sets of other open merge editors leave no room. */
  pinSet(owner: string, items: readonly { readonly content: Buffer; readonly label: string }[]): vscode.Uri[] {
    const texts = items.map(item => {
      if (item.content.length > 5 * 1024 * 1024 || item.content.includes(0)) throw new Error('Unsupported text revision.');
      return new TextDecoder('utf-8', { fatal: true }).decode(item.content);
    });
    this.pins.delete(owner);
    const incoming = items.reduce((total, item) => total + item.content.length, 0), pinned = new Set([...this.pins.values()].flat());
    for (const [id, entry] of this.entries) {
      if (this.entries.size + items.length <= this.limits.entries && this.bytes + incoming <= this.limits.bytes) break;
      if (pinned.has(id)) continue;
      this.entries.delete(id); this.bytes -= entry.bytes;
    }
    if (this.entries.size + items.length > this.limits.entries || this.bytes + incoming > this.limits.bytes) throw new Error('Too many merge editors are open. Close one, then try again.');
    const ids = items.map((item, index) => { const id = randomUUID(); this.entries.set(id, { text: texts[index]!, bytes: item.content.length }); this.bytes += item.content.length; return id; });
    this.pins.set(owner, ids);
    return ids.map((id, index) => vscode.Uri.from({ scheme: CONFLICT_SCHEME, path: `/${id}/${items[index]!.label.split(/[\\/]/).at(-1) || 'conflict.txt'}` }));
  }
  /** The merge tab closed: its inputs become evictable. */
  release(owner: string): void { this.pins.delete(owner); }
  /** The snapshot behind this URI is still held: a merge tab restored after a reload reads expired inputs and must be reopened. */
  has(uri: vscode.Uri): boolean { return uri.scheme === CONFLICT_SCHEME && this.entries.has(uri.path.split('/')[1] ?? ''); }
  provideTextDocumentContent(uri: vscode.Uri): string {
    const entry = this.entries.get(uri.path.split('/')[1] ?? '');
    if (!entry) throw new Error('Conflict snapshot expired. Reopen the merge from Git Pro Conflicts.');
    return entry.text;
  }
  dispose(): void { this.entries.clear(); this.pins.clear(); this.bytes = 0; }
}
