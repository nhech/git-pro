import type { Disposable } from '../utils/events';
/** Shared-ref mutations across linked worktrees must not overlap. */
export class OperationCoordinator implements Disposable {
  private readonly tails = new Map<string, Promise<void>>();
  private disposed = false;
  constructor(private readonly guard: () => void) {}
  async run<T>(commonDir: string, action: () => Promise<T>, refresh: () => Promise<void>): Promise<T> {
    if (this.disposed) throw new Error('Operation coordinator is disposed.');
    const previous = this.tails.get(commonDir) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(commonDir, tail);
    await previous;
    try {
      if (this.disposed) throw new Error('Operation coordinator is disposed.');
      this.guard();
      let actionFailed = false;
      try { return await action(); }
      catch (error) { actionFailed = true; throw error; }
      finally {
        try { await refresh(); }
        catch (error) { if (!actionFailed) throw error; }
      }
    } finally {
      release(); if (this.tails.get(commonDir) === tail) this.tails.delete(commonDir);
    }
  }
  /** A mutation for this common directory is queued or running. */
  busy(commonDir: string): boolean { return this.tails.has(commonDir); }
  dispose(): void { this.disposed = true; }
}
