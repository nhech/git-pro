import { sameStatus, type StatusSnapshot } from '../git/git-parser';
import type { GitOperation } from './operation-state';
import { Emitter } from '../utils/events';
export interface RepositorySnapshot extends StatusSnapshot {
  /** `refreshedAt` is when this content was first observed; identical re-reads keep the same snapshot. */
  readonly id: string; readonly version: number; readonly operation: GitOperation; readonly refreshedAt: number;
}
export class RepositoryStore {
  private readonly snapshots = new Map<string, RepositorySnapshot>();
  private readonly changed = new Emitter<string>();
  readonly onDidChange = this.changed.event;
  get(id: string): RepositorySnapshot | undefined { return this.snapshots.get(id); }
  /** Returns false, leaving the current immutable snapshot in place, when nothing observable changed. */
  update(id: string, status: StatusSnapshot, operation: GitOperation): boolean {
    const current = this.snapshots.get(id);
    if (current && current.operation === operation && sameStatus(current, status)) return false;
    const version = (current?.version ?? 0) + 1;
    this.snapshots.set(id, Object.freeze({ ...status, id, version, operation, refreshedAt: Date.now() }));
    this.changed.fire(id);
    return true;
  }
  remove(id: string): void { this.snapshots.delete(id); this.changed.fire(id); }
  dispose(): void { this.snapshots.clear(); this.changed.dispose(); }
}
