import type { ConflictKind, ConflictRow, SideStatus } from '../../git/conflicts/conflict-contract';
import type { GitOperation } from '../../state/operation-state';

export type ResolveAction = 'acceptYours' | 'acceptTheirs' | 'markResolved';
export type CompareAction = 'compareBaseYours' | 'compareBaseTheirs' | 'compareYoursTheirs';
export type OpenAction = 'merge' | 'file' | CompareAction;
export type OperationAction = 'continue' | 'abort' | 'skip' | 'dropStash' | 'close' | 'scm';
/** Webview → host (§3.11). Rows are named only by opaque keys (N1); every request that acts carries the `revision` of the rows it was built from. */
export type ConflictsRequest =
  | { type: 'ready'; session: string } | { type: 'refresh'; session: string }
  /** "Use Column Layout in Merge Editor": a view preference for the next merge editor, so it carries no revision. */
  | { type: 'columnLayout'; session: string }
  | { type: 'select'; session: string; keys: string[] }
  | { type: 'setting'; session: string; groupByDirectory: boolean }
  | { type: 'resolve'; session: string; revision: number; action: ResolveAction; keys: string[] }
  /** `keys` only for Merge… on several rows, which opens them in sequence; it includes `key`. */
  | { type: 'open'; session: string; revision: number; action: OpenAction; key: string; keys?: string[] }
  | { type: 'operation'; session: string; revision: number; action: OperationAction };

/** SHA-256 of the row identity in base64url: fixed length whatever the path. */
const key = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const keys = (value: unknown, minimum: number): value is string[] => Array.isArray(value) && value.length >= minimum && value.length <= 100 && value.every(key) && new Set(value).size === value.length;
const resolveActions = new Set<string>(['acceptYours', 'acceptTheirs', 'markResolved']);
const openActions = new Set<string>(['merge', 'file', 'compareBaseYours', 'compareBaseTheirs', 'compareYoursTheirs']);
const operationActions = new Set<string>(['continue', 'abort', 'skip', 'dropStash', 'close', 'scm']);

/** Strict: unknown types and actions are refused and unknown fields are dropped. */
export function parseConflictsRequest(value: unknown): ConflictsRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Conflicts request.');
  const item = value as Record<string, unknown>;
  if (typeof item.session !== 'string' || !/^[a-f0-9-]{36}$/.test(item.session)) throw new Error('Conflicts session expired.');
  const session = item.session;
  if (item.type === 'ready' || item.type === 'refresh' || item.type === 'columnLayout') return { type: item.type, session };
  if (item.type === 'select') { if (!keys(item.keys, 0)) throw new Error('Select up to 100 conflicted files.'); return { type: 'select', session, keys: [...item.keys] }; }
  if (item.type === 'setting') { if (typeof item.groupByDirectory !== 'boolean') throw new Error('Invalid Conflicts setting.'); return { type: 'setting', session, groupByDirectory: item.groupByDirectory }; }
  if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 0) throw new Error('Conflicts changed. Review again.');
  const revision = item.revision as number;
  if (item.type === 'resolve' && typeof item.action === 'string' && resolveActions.has(item.action)) {
    if (!keys(item.keys, 1)) throw new Error('Select 1–100 conflicted files.');
    return { type: 'resolve', session, revision, action: item.action as ResolveAction, keys: [...item.keys] };
  }
  if (item.type === 'open' && typeof item.action === 'string' && openActions.has(item.action)) {
    if (!key(item.key)) throw new Error('Invalid conflict row.');
    if (item.keys === undefined) return { type: 'open', session, revision, action: item.action as OpenAction, key: item.key };
    if (item.action !== 'merge' || !keys(item.keys, 1) || !item.keys.includes(item.key)) throw new Error('Invalid conflict selection.');
    return { type: 'open', session, revision, action: 'merge', key: item.key, keys: [...item.keys] };
  }
  if (item.type === 'operation' && typeof item.action === 'string' && operationActions.has(item.action)) return { type: 'operation', session, revision, action: item.action as OperationAction };
  throw new Error('Unknown Conflicts action.');
}

/** Kind text in WebStorm terms: WP1 already swapped "us" and "them" for a rebase (D3). */
export const kindLabels: Readonly<Record<ConflictKind, string>> = {
  bothModified: 'Both modified', bothAdded: 'Both added', deletedByUs: 'Deleted by us', deletedByThem: 'Deleted by them',
  addedByUs: 'Added by us', addedByThem: 'Added by them', bothDeleted: 'Both deleted'
};
export const sideLabels: Readonly<Record<SideStatus, string>> = { modified: 'Modified', added: 'Added', deleted: 'Deleted', absent: 'Absent' };
/** Why Merge… is unavailable for a row, in the words of the Conflicts tab tooltip. */
export function mergeBlocker(row: Pick<ConflictRow, 'kind' | 'binary' | 'unsupported' | 'workingFile' | 'mergeable'>): string {
  if (row.unsupported) return row.unsupported;
  if (row.binary) return 'Binary file — choose Accept Yours or Accept Theirs.';
  if (row.kind === 'bothModified' || row.kind === 'bothAdded') return row.workingFile ? 'Not mergeable as text — choose Accept Yours or Accept Theirs.' : 'No working file — choose Accept Yours or Accept Theirs.';
  return `${kindLabels[row.kind]} — choose Accept Yours or Accept Theirs.`;
}

/** Host → webview row. Paths and labels are redacted and rendered with textContent only. */
export interface ConflictsRowState {
  readonly key: string; readonly group: 'unresolved' | 'resolved'; readonly path: string; readonly kind: ConflictKind;
  readonly yours: SideStatus; readonly theirs: SideStatus;
  /** `unknown`: the file was not read for markers (binary, unsupported, missing or past the 16 MiB budget). */
  readonly markers: 'present' | 'none' | 'unknown'; readonly blocks: number | null;
  readonly binary: boolean; readonly mergeable: boolean; readonly unsupported?: string; readonly mergeOpen: boolean; readonly workingFile: boolean;
}
export interface ConflictsSideState { readonly label: 'Yours' | 'Theirs'; readonly ref?: string; readonly oid?: string; readonly subject?: string; readonly flag: 'ours' | 'theirs' }
export interface ConflictsOperationState {
  readonly kind: GitOperation; readonly title: string; readonly yours: ConflictsSideState; readonly theirs: ConflictsSideState;
  readonly progress?: { readonly current: number; readonly total: number };
  /** Conflicts left in the repository, which can exceed the listed rows (5000). */
  readonly conflicts: number;
  readonly canContinue: boolean; readonly canSkip: boolean; readonly canAbort: boolean; readonly nativeOnly: boolean; readonly editStop: boolean;
  /** `drop` only after a Git Pro stash pop stopped on conflicts (§3.2 Finish). */
  readonly stash?: { readonly selector: string; readonly drop: boolean };
}
