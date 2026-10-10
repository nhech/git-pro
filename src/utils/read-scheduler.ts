/** Bounded, cancellable read queue. Mutations use their separate coordinator. */
export class ReadScheduler {
  private active = 0;
  private readonly pending: { start: () => void; reject: (error: Error) => void }[] = [];
  private readonly lifetime = new AbortController();
  constructor(private readonly concurrency = 2, private readonly capacity = 20) {}
  run<T>(action: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    const signal = external ? AbortSignal.any([external, this.lifetime.signal]) : this.lifetime.signal;
    if (signal.aborted) return Promise.reject(new Error('History read cancelled.'));
    if (this.pending.length >= this.capacity) return Promise.reject(new Error('Too many history requests. Wait for pending reads.'));
    return new Promise<T>((resolve, reject) => {
      const cancelled = () => {
        const index = this.pending.indexOf(task);
        if (index >= 0) { this.pending.splice(index, 1); reject(new Error('History read cancelled.')); }
      };
      const task = { reject, start: () => {
        signal.removeEventListener('abort', cancelled);
        if (signal.aborted) { reject(new Error('History read cancelled.')); this.pump(); return; }
        this.active++;
        void Promise.resolve().then(() => action(signal)).then(resolve, reject).finally(() => { this.active--; this.pump(); });
      } };
      signal.addEventListener('abort', cancelled, { once: true });
      this.pending.push(task); this.pump();
    });
  }
  private pump(): void { while (this.active < this.concurrency && this.pending.length) this.pending.shift()!.start(); }
  dispose(): void { this.lifetime.abort(); for (const task of this.pending.splice(0)) task.reject(new Error('History reads disposed.')); }
}
