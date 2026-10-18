import { validateOid } from '../../security/refs';
import type { GitService } from '../git.service';
import { undoNamePattern } from './undo-builders';

/**
 * The safety net under what Git Pro throws away: a discard of working changes, a hard reset, a force push. Before it acts, Git Pro keeps what the action would lose, as a commit under
 * `refs/gitpro/undo/` (see undo-builders.ts), and records what it was in the workspace state, so Undo… can put it back. At most 20 copies per repository, none older than 30 days; the rest
 * are let go, and `git gc` takes their objects. No `vscode` import: unit tests load this module as it is.
 */
export type UndoKind = 'discard' | 'reset' | 'push';
interface Common { readonly id: string; readonly time: number; /** What the user did, in words: "Discarded 3 files". */ readonly label: string }
/** The tracked changes of the working tree before a discard, and the files the discard touched. */
export interface DiscardEntry extends Common { readonly kind: 'discard'; readonly snapshot: string; readonly paths: readonly string[] }
/** HEAD before a hard reset, and the tracked changes of the working tree when there were any. */
export interface ResetEntry extends Common { readonly kind: 'reset'; readonly head: string; readonly snapshot?: string; readonly branch?: string }
/** A branch of a remote before a force push replaced it, and what replaced it. */
export interface PushEntry extends Common { readonly kind: 'push'; readonly remote: string; readonly url: string; readonly branch: string; readonly oldTip: string; readonly newTip: string }
export type UndoEntry = DiscardEntry | ResetEntry | PushEntry;
export type UndoInput =
  { readonly kind: 'discard'; readonly label: string; readonly paths: readonly string[] } |
  { readonly kind: 'reset'; readonly label: string; readonly head: string; readonly branch?: string } |
  { readonly kind: 'push'; readonly label: string; readonly remote: string; readonly url: string; readonly branch: string; readonly oldTip: string; readonly newTip: string };

/** What the service asks of Git. */
export interface UndoBackend {
  /** The commit that holds the tracked changes of the working tree, or undefined when nothing differs from HEAD. */
  snapshot(root: string): Promise<string | undefined>;
  keep(root: string, name: string, oid: string): Promise<void>;
  drop(root: string, name: string): Promise<void>;
  exists(root: string, oid: string): Promise<boolean>;
}
export interface UndoMemento { get<T>(key: string, fallback: T): T; update(key: string, value: unknown): PromiseLike<void> }

/** A copy that cannot be made, so the action is not to run unprotected unless the caller chooses to. */
export class UndoUnavailable extends Error {}

export const undoLimit = 20;
export const undoMaxAge = 30 * 24 * 60 * 60 * 1000;
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');

/** The records of the workspace state as data: anything that is not exactly an entry is left out. */
export function parseUndoEntries(value: unknown): UndoEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: UndoEntry[] = [];
  for (const item of value.slice(0, 100)) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || !undoNamePattern.test(entry.id) || !entry.id.includes(`-${String(entry.kind)}`) || typeof entry.time !== 'number' || !Number.isFinite(entry.time) || !text(entry.label, 300)) continue;
    const common = { id: entry.id, time: entry.time, label: entry.label };
    if (entry.kind === 'discard' && typeof entry.snapshot === 'string' && oidPattern.test(entry.snapshot) && Array.isArray(entry.paths) && entry.paths.length > 0 && entry.paths.length <= 5000 && entry.paths.every(path => text(path, 4096))) entries.push({ ...common, kind: 'discard', snapshot: entry.snapshot, paths: entry.paths as string[] });
    else if (entry.kind === 'reset' && typeof entry.head === 'string' && oidPattern.test(entry.head) && (entry.snapshot === undefined || (typeof entry.snapshot === 'string' && oidPattern.test(entry.snapshot))) && (entry.branch === undefined || text(entry.branch, 255)))
      entries.push({ ...common, kind: 'reset', head: entry.head, ...(entry.snapshot === undefined ? {} : { snapshot: entry.snapshot as string }), ...(entry.branch === undefined ? {} : { branch: entry.branch as string }) });
    else if (entry.kind === 'push' && text(entry.remote, 255) && text(entry.url, 2048) && text(entry.branch, 255) && typeof entry.oldTip === 'string' && oidPattern.test(entry.oldTip) && typeof entry.newTip === 'string' && oidPattern.test(entry.newTip))
      entries.push({ ...common, kind: 'push', remote: entry.remote, url: entry.url, branch: entry.branch, oldTip: entry.oldTip, newTip: entry.newTip });
  }
  return entries.sort((a, b) => b.time - a.time);
}

export class UndoService {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly backend: UndoBackend, private readonly state: UndoMemento, private readonly now: () => number = Date.now) {}
  private key(repositoryId: string): string { return `gitPro.undo:${repositoryId}`; }
  /** One write at a time, so two copies saved together are both recorded. */
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const run = this.tail.then(action, action);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
  private all(repositoryId: string): UndoEntry[] { return parseUndoEntries(this.state.get<unknown>(this.key(repositoryId), [])); }
  /** The copies of a repository, newest first, without the ones older than the time they are kept for. */
  list(repositoryId: string): UndoEntry[] {
    const limit = this.now() - undoMaxAge;
    return this.all(repositoryId).filter(entry => entry.time >= limit).slice(0, undoLimit);
  }
  /** Whether the repository has the commit, so a copy of it can be kept. */
  holds(root: string, oid: string): Promise<boolean> { return this.backend.exists(root, oid); }
  find(repositoryId: string, id: string): UndoEntry | undefined { return this.list(repositoryId).find(entry => entry.id === id); }
  /**
   * Keeps what the action is about to lose. A discard needs its copy (it throws when none could be made, and the discard is not to run); a hard reset keeps HEAD even when the changes could not
   * be saved (they are what the user already agreed to lose); a force push needs the old tip to be in this repository, or throws UndoUnavailable.
   */
  save(repositoryId: string, root: string, input: UndoInput): Promise<UndoEntry> {
    return this.exclusive(async () => {
      let snapshot: string | undefined, keep: string;
      if (input.kind === 'discard') {
        const made = await this.backend.snapshot(root);
        if (!made) throw new UndoUnavailable('Git has no copy of the changes to keep.');
        snapshot = validateOid(made); keep = snapshot;
      } else if (input.kind === 'reset') {
        const made = await this.backend.snapshot(root).catch(() => undefined);
        snapshot = made ? validateOid(made) : undefined; keep = snapshot ?? validateOid(input.head);
      } else {
        if (!await this.backend.exists(root, validateOid(input.oldTip))) throw new UndoUnavailable('The remote branch\'s current commit is not in this repository.');
        keep = input.oldTip;
      }
      const time = this.now(), existing = this.all(repositoryId), taken = new Set(existing.map(entry => entry.id));
      let id = `${time}-${input.kind}`;
      for (let n = 1; taken.has(id) && n < 1000; n++) id = `${time}-${input.kind}-${n}`;
      await this.backend.keep(root, id, keep);
      const common = { id, time, label: input.label.slice(0, 300) };
      const entry: UndoEntry = input.kind === 'discard' ? { ...common, kind: 'discard', snapshot: snapshot!, paths: [...input.paths] }
        : input.kind === 'reset' ? { ...common, kind: 'reset', head: validateOid(input.head), ...(snapshot ? { snapshot } : {}), ...(input.branch ? { branch: input.branch } : {}) }
        : { ...common, kind: 'push', remote: input.remote, url: input.url, branch: input.branch, oldTip: validateOid(input.oldTip), newTip: validateOid(input.newTip) };
      await this.write(repositoryId, root, [entry, ...existing]);
      return entry;
    });
  }
  /** Lets one copy go: its record and its ref. */
  remove(repositoryId: string, root: string, id: string): Promise<void> {
    return this.exclusive(async () => {
      const entries = this.all(repositoryId);
      await this.backend.drop(root, id).catch(() => undefined);
      await this.state.update(this.key(repositoryId), entries.filter(entry => entry.id !== id));
    });
  }
  /** Records the entries and lets go of the copies beyond the limit or past their age. */
  private async write(repositoryId: string, root: string, entries: readonly UndoEntry[]): Promise<void> {
    const limit = this.now() - undoMaxAge, sorted = [...entries].sort((a, b) => b.time - a.time);
    const kept = sorted.filter(entry => entry.time >= limit).slice(0, undoLimit), keptIds = new Set(kept.map(entry => entry.id));
    await this.state.update(this.key(repositoryId), kept);
    for (const entry of sorted) if (!keptIds.has(entry.id)) await this.backend.drop(root, entry.id).catch(() => undefined);
  }
}

/** The service's Git, over the owned executor: `git stash create` for the changes, and refs of Git Pro's own to keep commits alive. */
export function gitUndoBackend(git: GitService): UndoBackend {
  return {
    snapshot: async root => { const made = (await git.executor.mutate(root, { kind: 'undoSnapshot' })).stdout.toString('utf8').trim(); return made ? validateOid(made) : undefined; },
    keep: async (root, name, oid) => { await git.executor.mutate(root, { kind: 'undoKeep', name, oid }); },
    drop: async (root, name) => { await git.executor.mutate(root, { kind: 'undoDrop', name }); },
    exists: async (root, oid) => { try { await git.executor.read(root, { kind: 'ref', ref: validateOid(oid) }); return true; } catch { return false; } },
  };
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function describeAge(time: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
