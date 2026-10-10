/** Bounds concurrent asynchronous work; queued work can still be cancelled before it starts. */
export class Limiter {
  private active = 0;
  private readonly waiting: { start: () => void; cancel: () => void }[] = [];
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Concurrency limit must be a positive integer.');
  }
  get running(): number { return this.active; }
  get queued(): number { return this.waiting.length; }
  async run<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error('Cancelled before start.');
    if (this.active < this.limit) this.active++;
    else {
      await new Promise<void>((resolve, reject) => {
        const entry = {
          // release() hands its slot straight to the next waiter, so `active` never dips below the running count.
          start: () => { signal?.removeEventListener('abort', entry.cancel); resolve(); },
          cancel: () => {
            const index = this.waiting.indexOf(entry);
            if (index >= 0) { this.waiting.splice(index, 1); reject(new Error('Cancelled while queued.')); }
          }
        };
        signal?.addEventListener('abort', entry.cancel, { once: true });
        this.waiting.push(entry);
      });
    }
    try { return await action(); }
    finally { this.release(); }
  }
  private release(): void {
    const next = this.waiting.shift();
    if (next) next.start();
    else this.active--;
  }
}
