import { realpath } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { GitExecutor } from '../git/git-executor';
import { parseStatus, sameStatus, type StatusSnapshot } from '../git/git-parser';
import { PathPolicy, containsPath, canonicalFilePath } from '../security/paths';
import { redact } from '../security/redaction';
import { detectOperation, type GitOperation } from '../state/operation-state';
import { RepositoryStore } from '../state/repository-store';
import { Emitter, type Disposable } from '../utils/events';
import { Limiter } from '../utils/limiter';
import type { Logger } from '../utils/logging';

/** `snapshot` returns undefined when the source cannot describe the whole status (the owned read then decides alone). */
export interface RepositoryHandle { root: string; onDidChange: (listener: () => void) => Disposable; snapshot?: () => StatusSnapshot | undefined }
export interface RepositoryDescriptor { readonly id: string; readonly root: string; readonly gitDir: string; readonly commonDir: string }
export interface RegistryOptions {
  /** Safety-net polling runs only while this returns true, for example while the window has focus. */
  isActive?: () => boolean;
  /** A mutation is running on this repository and ends with an explicit refresh: background reads wait instead of racing it. */
  isBusy?: (repo: RepositoryDescriptor) => boolean;
  /** Global bound on concurrent background refreshes across all repositories; explicit refreshes (a mutation or the user is waiting) are never queued. */
  maxConcurrentReads?: number;
  /** Window for reloading ref/stash/tag views because of built-in API activity, ref-file changes or polling: the first request reloads at once, the rest collapse into one trailing reload. */
  invalidateThrottleMs?: number;
  /** Coalescing delay between a change signal and the owned status read. */
  debounceMs?: number;
}
interface Entry {
  descriptor: RepositoryDescriptor; handle: RepositoryHandle; subscriptions: Disposable[];
  watchers: FSWatcher[]; controller: AbortController; timer: ReturnType<typeof setTimeout> | undefined;
  refreshing: Promise<void> | undefined; pending: boolean;
  /** An explicit refresh asked views of refs, stashes, tags and remotes to reload even if status is unchanged. */
  notify: boolean;
  /** Digest of the bytes behind the snapshot this registry installed, so identical re-reads skip parsing. */
  known: { digest: string; operation: GitOperation; version: number } | undefined;
  idle: number; nextPollAt: number; checkedAt: number;
  /** The next read was started by the safety-net poll (or a focus catch-up), so an unchanged result still revalidates ref views. */
  polled: boolean;
  /** A background read is waiting for a free read slot. */
  queued: boolean;
  /** Time of the last read request, and whether a request waited for a running mutation to finish. */
  requestedAt: number; deferred: boolean;
  invalidateTimer: ReturnType<typeof setTimeout> | undefined; invalidateQueued: boolean;
  /** An API snapshot shown ahead of the owned read: what it replaced and what it showed, checked by the next owned read. */
  api: { before: StatusSnapshot | undefined; shown: StatusSnapshot } | undefined;
  /** Consecutive owned reads that restored the state an API snapshot had replaced; at API_MISS_LIMIT the API snapshot is ignored. */
  apiMisses: number;
}
/** Idle polls back off to this multiple of the base interval; any activity restores the base interval. */
const MAX_POLL_BACKOFF = 6;
/** Ref/stash/tag changes do not show in status, so views of them are revalidated on activity, at most once per window. */
const DEFAULT_INVALIDATE_THROTTLE_MS = 10_000;
/** Documented design bound for concurrent heavy reads across the extension. */
const DEFAULT_CONCURRENT_READS = 4;
/** An API snapshot that disagrees with git status (untracked files hidden, VS Code's status limit, ...) is shown and then reverted, rebuilding every view twice. */
const API_MISS_LIMIT = 2;
const backoff = (idle: number): number => Math.min(MAX_POLL_BACKOFF, 2 ** Math.min(idle, 3));

export class RepositoryRegistry implements Disposable {
  private readonly entries = new Map<string, Entry>();
  private readonly changed = new Emitter<void>();
  private readonly invalidated = new Emitter<void>();
  /** Repository set, selection, status snapshot or status error changed. */
  readonly onDidChange = this.changed.event;
  /** Everything derived from a repository (refs, stashes, tags, remotes) may be stale; includes every onDidChange. */
  readonly onDidInvalidate = this.invalidated.event;
  private generation = 0; private disposed = false;
  private selected: string | undefined;
  readonly errors = new Map<string, string>();
  private readonly poll: ReturnType<typeof setInterval>;
  private readonly limiter: Limiter;
  private readonly isActive: () => boolean;
  private readonly isBusy: (repo: RepositoryDescriptor) => boolean;
  private readonly invalidateThrottleMs: number;
  private readonly debounceMs: number;
  constructor(private readonly policy: PathPolicy, private readonly executor: GitExecutor,
    readonly store: RepositoryStore, private readonly logger: Logger, private readonly intervalMs = 5000, options: RegistryOptions = {}) {
    this.limiter = new Limiter(options.maxConcurrentReads ?? DEFAULT_CONCURRENT_READS);
    this.isActive = options.isActive ?? (() => true);
    this.isBusy = options.isBusy ?? (() => false);
    this.invalidateThrottleMs = options.invalidateThrottleMs ?? DEFAULT_INVALIDATE_THROTTLE_MS;
    this.debounceMs = options.debounceMs ?? 250;
    this.poll = setInterval(() => this.tick(), intervalMs);
    this.poll.unref();
  }
  list(): RepositoryDescriptor[] { return [...this.entries.values()].map(entry => entry.descriptor); }
  get active(): RepositoryDescriptor | undefined { return this.selected ? this.entries.get(this.selected)?.descriptor : undefined; }
  select(id: string): void { if (!this.entries.has(id)) throw new Error('Repository is no longer open.'); this.selected = id; this.emitChanged(); }
  async resolveFile(file: string): Promise<RepositoryDescriptor | undefined> {
    const canonical = await canonicalFilePath(file);
    return this.list().filter(repo => containsPath(repo.root, canonical)).sort((a, b) => b.root.length - a.root.length)[0];
  }
  async sync(handles: readonly RepositoryHandle[]): Promise<void> {
    const generation = ++this.generation;
    const desired = new Set<string>();
    for (const handle of handles) {
      if (this.disposed || generation !== this.generation) return;
      try {
        const root = await this.policy.authorizeRoot(handle.root);
        const id = process.platform === 'win32' ? root.toLowerCase() : root;
        desired.add(id);
        if (this.entries.has(id)) continue;
        const gitDirResult = await this.executor.read(root, { kind: 'metadata', field: 'gitDir' });
        const commonDirResult = await this.executor.read(root, { kind: 'metadata', field: 'commonDir' });
        const gitDir = await realpath(path.resolve(root, gitDirResult.stdout.toString('utf8').trim()));
        const commonDir = await realpath(path.resolve(root, commonDirResult.stdout.toString('utf8').trim()));
        if (this.disposed || generation !== this.generation) return;
        const descriptor = Object.freeze({ id, root, gitDir, commonDir });
        const entry: Entry = { descriptor, handle, subscriptions: [], watchers: [], controller: new AbortController(),
          timer: undefined, refreshing: undefined, pending: false, notify: false, known: undefined, idle: 0, nextPollAt: 0, checkedAt: 0,
          polled: false, queued: false, requestedAt: 0, deferred: false, invalidateTimer: undefined, invalidateQueued: false, api: undefined, apiMisses: 0 };
        this.entries.set(id, entry);
        entry.subscriptions.push(handle.onDidChange(() => {
          if (this.entries.get(id) !== entry || this.disposed) return;
          // API provides an immediate UI snapshot; the owned read then reconciles
          // filesystem metadata and changes made by external Git processes.
          if (handle.snapshot && entry.apiMisses < API_MISS_LIMIT) {
            try {
              const before = this.store.get(id), snapshot = handle.snapshot();
              if (snapshot && this.store.update(id, snapshot, before?.operation ?? 'idle')) { entry.api = { before: entry.api ? entry.api.before : before, shown: snapshot }; this.emitChanged(); }
            }
            catch { this.logger.error('Git API snapshot unavailable; refreshing through the read layer.'); }
          }
          // Ref, stash and tag changes do not show up in status, so API activity also revalidates views of them (throttled).
          this.requestInvalidation(entry);
          entry.idle = 0; entry.nextPollAt = Date.now() + this.intervalMs;
          this.schedule(id);
        }));
        for (const directory of new Set([gitDir, commonDir])) {
          try {
            const watcher = watch(directory, (_event, file) => {
              const name = file?.toString();
              if (name && /^(HEAD|index|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|BISECT_LOG|rebase-|sequencer|refs|packed-refs)/.test(name)) {
                entry.idle = 0; this.schedule(id);
                if (/^(HEAD|refs|packed-refs)/.test(name)) this.requestInvalidation(entry);
              }
            });
            watcher.on('error', () => this.logger.error('Metadata watcher unavailable; periodic refresh remains enabled.'));
            entry.watchers.push(watcher);
          } catch { this.logger.error('Metadata watcher unavailable; periodic refresh remains enabled.'); }
        }
        this.selected ??= id;
        await this.refresh(id);
      } catch (error) { this.logger.error(`Repository discovery failed: ${redact(String(error))}`); }
    }
    if (this.disposed || generation !== this.generation) return;
    for (const id of this.entries.keys()) if (!desired.has(id)) this.remove(id);
    this.emitChanged();
  }
  /** Explicit refresh: always reloads views of refs, stashes and tags, and notifies status consumers only if status changed. */
  async refresh(id?: string): Promise<void> {
    if (!id) { for (const entryId of this.entries.keys()) await this.refresh(entryId); return; }
    await this.load(id, true);
  }
  /** Resume safety-net polling immediately, for example when the window regains focus; repositories checked within one interval are left alone. */
  wake(): void {
    if (this.disposed) return;
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      entry.idle = 0;
      if (now - entry.checkedAt >= this.intervalMs) { entry.nextPollAt = 0; entry.polled = true; this.schedule(id); }
      else entry.nextPollAt = Math.min(entry.nextPollAt, entry.checkedAt + this.intervalMs);
    }
  }
  private async load(id: string, explicit: boolean): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || this.disposed) return;
    if (explicit) entry.notify = true;
    if (entry.refreshing) { entry.pending = true; return entry.refreshing; }
    // Cleared the moment the cycle settles (that reaction is registered before any waiter's), so a load arriving right at
    // the end starts its own cycle instead of setting flags on a finished one.
    entry.refreshing = this.cycle(id, entry).finally(() => { entry.refreshing = undefined; });
    await entry.refreshing;
  }
  private async cycle(id: string, entry: Entry): Promise<void> {
    do {
      entry.pending = false;
      const polled = entry.polled; entry.polled = false;
      let changed = false;
      try {
        // Owned read captures external checkout/status even when API events are delayed.
        const result = await this.executor.read(entry.descriptor.root, { kind: 'status' }, { signal: entry.controller.signal });
        const operation = await detectOperation(entry.descriptor.gitDir);
        if (this.entries.get(id) !== entry || this.disposed) return;
        changed = this.install(id, entry, result.stdout, operation);
        if (this.errors.delete(id)) changed = true;
      } catch (error) {
        if (!entry.controller.signal.aborted && !this.disposed) {
          const message = redact(String(error));
          if (this.errors.get(id) !== message) { changed = true; this.logger.error(`Status refresh failed: ${message}`); }
          this.errors.set(id, message);
        }
      }
      entry.idle = changed ? 0 : entry.idle + 1;
      entry.checkedAt = Date.now();
      entry.nextPollAt = entry.checkedAt + this.intervalMs * backoff(entry.idle);
      const reload = entry.notify; entry.notify = false;
      if (changed) this.emitChanged(); else if (reload) this.invalidated.fire(); else if (polled) this.requestInvalidation(entry);
    } while (entry.pending && !this.disposed && !entry.controller.signal.aborted);
  }
  /** Returns true when the store now holds different content than before this read. */
  private install(id: string, entry: Entry, raw: Buffer, operation: GitOperation): boolean {
    const digest = createHash('sha256').update(raw).digest('hex');
    const current = this.store.get(id), known = entry.known;
    // Same bytes, same operation, and nobody (for example the API path) replaced the snapshot since: nothing to parse or publish.
    if (known && current && current.version === known.version && known.operation === operation && known.digest === digest) return false;
    const status = parseStatus(raw), api = entry.api; entry.api = undefined;
    if (api && sameStatus(status, api.shown)) entry.apiMisses = 0;
    else if (api?.before && sameStatus(status, api.before) && ++entry.apiMisses === API_MISS_LIMIT) this.logger.info('Built-in Git API status disagrees with git status for this repository; showing owned reads only.');
    const replaced = this.store.update(id, status, operation);
    const installed = this.store.get(id);
    entry.known = installed ? { digest, operation, version: installed.version } : undefined;
    return replaced;
  }
  private tick(): void {
    if (this.disposed || !this.isActive()) return;
    const now = Date.now();
    // Half an interval of slack keeps a 5 s cadence from stretching to 10 s when a read finishes just after a tick.
    for (const [id, entry] of this.entries) {
      // A read already running or waiting answers this poll; marking it pending would queue a second read of a slow repository.
      if (entry.refreshing || entry.queued || entry.timer) continue;
      if (now + this.intervalMs / 2 >= entry.nextPollAt) { entry.polled = true; this.schedule(id); }
    }
  }
  /** `request` is false only when a deferred read re-arms itself, so the time of the last real request is kept. */
  private schedule(id: string, request = true): void {
    const entry = this.entries.get(id);
    if (!entry || this.disposed) return;
    if (request) entry.requestedAt = Date.now();
    if (entry.timer) return;
    entry.timer = setTimeout(() => { entry.timer = undefined; void this.background(id, entry); }, this.debounceMs);
  }
  /**
   * Background reads (polling, watcher and API signals) share a global bound. Explicit refreshes, which a mutation or the
   * user is waiting on, never queue here: they call load() directly.
   */
  private async background(id: string, entry: Entry): Promise<void> {
    if (this.disposed || this.entries.get(id) !== entry) return;
    // A running mutation ends with an explicit refresh; watcher events it causes must neither read status between its steps
    // nor queue a second read behind that refresh. Check again after the debounce.
    if (this.isBusy(entry.descriptor)) { entry.deferred = true; this.schedule(id, false); return; }
    if (entry.refreshing) { entry.pending = true; return; }
    if (entry.queued) return;
    // After a deferral, only requests newer than the mutation's own refresh still need a read.
    entry.queued = true; const queuedAt = entry.deferred ? entry.requestedAt : Date.now(); entry.deferred = false;
    try {
      await this.limiter.run(async () => {
        entry.queued = false;
        // An explicit refresh that ran while this waited for a slot already produced a newer read.
        if (this.entries.get(id) !== entry || this.disposed || entry.checkedAt >= queuedAt) return;
        await this.load(id, false);
      }, entry.controller.signal);
    } catch (error) {
      if (!entry.controller.signal.aborted && !this.disposed) this.logger.error(`Background refresh failed: ${redact(String(error))}`);
    } finally { entry.queued = false; }
  }
  /**
   * Views of refs, stashes, tags and remotes cannot see their changes in status. The first request in a window reloads
   * them at once; requests during the window collapse into a single trailing reload, so a burst of activity costs two.
   */
  private requestInvalidation(entry: Entry): void {
    if (this.disposed) return;
    if (entry.invalidateTimer) { entry.invalidateQueued = true; return; }
    this.invalidated.fire();
    entry.invalidateTimer = setTimeout(() => {
      entry.invalidateTimer = undefined;
      if (this.disposed || this.entries.get(entry.descriptor.id) !== entry || !entry.invalidateQueued) return;
      entry.invalidateQueued = false; this.requestInvalidation(entry);
    }, this.invalidateThrottleMs);
    entry.invalidateTimer.unref();
  }
  /** A throwing status listener must not also swallow the invalidation that follows it. */
  private emitChanged(): void { try { this.changed.fire(); } finally { this.invalidated.fire(); } }
  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.controller.abort(); if (entry.timer) clearTimeout(entry.timer); if (entry.invalidateTimer) clearTimeout(entry.invalidateTimer);
    for (const disposable of entry.subscriptions) disposable.dispose();
    for (const watcher of entry.watchers) watcher.close();
    this.entries.delete(id); this.errors.delete(id); this.store.remove(id);
    if (this.selected === id) this.selected = this.entries.keys().next().value;
  }
  dispose(): void {
    this.disposed = true; this.generation++; clearInterval(this.poll);
    for (const id of this.entries.keys()) this.remove(id);
    this.changed.dispose(); this.invalidated.dispose();
  }
}
