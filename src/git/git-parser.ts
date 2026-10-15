import { createHash } from 'node:crypto';
export type ChangeGroup = 'staged' | 'working' | 'untracked' | 'conflicts';
export interface FileChange { readonly path: string; readonly originalPath?: string; readonly status: string; readonly group: ChangeGroup }
/** A change whose path (or rename source) is not valid UTF-8. It has no path: decoding it lossily could name, stage or delete a different file. */
export interface OmittedChange { readonly status: string; readonly group: ChangeGroup }
export interface StatusSnapshot {
  readonly head: string | undefined; readonly oid: string | undefined; readonly upstream: string | undefined;
  readonly ahead: number | undefined; readonly behind: number | undefined; readonly changes: readonly FileChange[];
  /** Present only when some changes were left out of `changes` because Git Pro cannot represent their names. */
  readonly omitted?: readonly OmittedChange[];
}
/**
 * NUL-separated status records. Git paths are bytes: a record that is not valid UTF-8 is listed in `invalid` and kept as latin1, which
 * round-trips its exact bytes, so one such name sets aside only its own entry instead of the whole status.
 */
function statusRecords(buffer: Buffer): { records: string[]; invalid: ReadonlySet<number> } {
  try { return { records: new TextDecoder('utf-8', { fatal: true }).decode(buffer).split('\0'), invalid: new Set() }; }
  catch { /* Decoded record by record below. */ }
  const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }), records: string[] = [], invalid = new Set<number>();
  for (let start = 0; ;) {
    const end = buffer.indexOf(0, start), bytes = buffer.subarray(start, end < 0 ? buffer.length : end);
    try { records.push(strict.decode(bytes)); } catch { invalid.add(records.length); records.push(bytes.toString('latin1')); }
    if (end < 0) break;
    start = end + 1;
  }
  return { records, invalid };
}
function fields(record: string, count: number): { fields: string[]; path: string } {
  const values: string[] = []; let offset = 0;
  for (let index = 0; index < count; index++) {
    const end = record.indexOf(' ', offset);
    if (end < 0) throw new Error('Malformed Git status record.');
    values.push(record.slice(offset, end)); offset = end + 1;
  }
  return { fields: values, path: record.slice(offset) };
}
/**
 * True when both snapshots describe the same Git state. Change order is not significant:
 * the built-in API and `git status` order entries differently for the same state.
 */
/** Any change at all, including those whose names Git Pro cannot show: "clean" guards must not pass over a file they cannot list. */
export function hasChanges(status: Pick<StatusSnapshot, 'changes' | 'omitted'>): boolean { return status.changes.length > 0 || (status.omitted?.length ?? 0) > 0; }
export function sameStatus(a: StatusSnapshot, b: StatusSnapshot): boolean {
  if (a === b) return true;
  if (a.head !== b.head || a.oid !== b.oid || a.upstream !== b.upstream || a.ahead !== b.ahead || a.behind !== b.behind || a.changes.length !== b.changes.length) return false;
  const omitted = (snapshot: StatusSnapshot) => (snapshot.omitted ?? []).map(change => `${change.group}\0${change.status}`).sort().join('\n');
  if ((a.omitted?.length ?? 0) !== (b.omitted?.length ?? 0) || (a.omitted?.length && omitted(a) !== omitted(b))) return false;
  let ordered = true;
  for (let index = 0; index < a.changes.length; index++) {
    const x = a.changes[index]!, y = b.changes[index]!;
    if (x.path !== y.path || x.group !== y.group || x.status !== y.status || x.originalPath !== y.originalPath) { ordered = false; break; }
  }
  if (ordered) return true;
  const key = (change: FileChange) => `${change.group}\0${change.status}\0${change.path}\0${change.originalPath ?? ''}`;
  const remaining = new Map<string, number>();
  for (const change of a.changes) remaining.set(key(change), (remaining.get(key(change)) ?? 0) + 1);
  for (const change of b.changes) {
    const count = remaining.get(key(change));
    if (!count) return false;
    remaining.set(key(change), count - 1);
  }
  return true;
}
export function parseStatus(buffer: Buffer): StatusSnapshot {
  if (buffer.length && buffer[buffer.length - 1] !== 0) throw new Error('Truncated Git status.');
  // Never alias unsupported filename bytes through UTF-8 replacement characters: such an entry is omitted, never renamed.
  const { records, invalid } = statusRecords(buffer);
  let head: string | undefined, oid: string | undefined, upstream: string | undefined,
    ahead: number | undefined, behind: number | undefined;
  const changes: FileChange[] = [], omitted: OmittedChange[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    if (invalid.has(index) && record.startsWith('# ')) throw new Error('Git status names a branch that is not valid UTF-8.');
    if (record.startsWith('# branch.head ')) head = record.slice(14);
    else if (record.startsWith('# branch.oid ')) oid = record.slice(13) === '(initial)' ? undefined : record.slice(13);
    else if (record.startsWith('# branch.upstream ')) upstream = record.slice(18);
    else if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (!match) throw new Error('Malformed ahead/behind record.');
      ahead = Number(match[1]); behind = Number(match[2]);
    } else if (record.startsWith('? ')) {
      if (invalid.has(index)) omitted.push({ group: 'untracked', status: '?' });
      else changes.push({ path: record.slice(2), group: 'untracked', status: '?' });
    } else if (record.startsWith('! ') || record.startsWith('# ')) continue;
    else if (/^[12u] /.test(record)) {
      const parsed = fields(record, record[0] === '1' ? 8 : record[0] === '2' ? 9 : 10);
      const xy = parsed.fields[1];
      if (!xy || xy.length !== 2 || !parsed.path) throw new Error('Malformed change record.');
      let originalPath: string | undefined, unnamed = invalid.has(index);
      if (record[0] === '2') { originalPath = records[++index]; if (!originalPath) throw new Error('Missing rename source.'); unnamed ||= invalid.has(index); }
      const renamed = originalPath === undefined ? {} : { originalPath };
      const add = (status: string, group: ChangeGroup) => { if (unnamed) omitted.push({ status, group }); else changes.push({ path: parsed.path, status, group, ...renamed }); };
      if (record[0] === 'u') add(xy, 'conflicts');
      else {
        if (xy[0] !== '.') add(xy[0]!, 'staged');
        if (xy[1] !== '.') add(xy[1]!, 'working');
      }
    } else throw new Error('Unsupported Git status record.');
  }
  return Object.freeze({ head, oid, upstream, ahead, behind, changes: Object.freeze(changes.map(change => Object.freeze(change))),
    ...(omitted.length ? { omitted: Object.freeze(omitted.map(change => Object.freeze(change))) } : {}) });
}
/**
 * Digest of every index entry that differs from HEAD, taken from the same `git status --porcelain=v2 -z`
 * bytes. Together with HEAD's OID it identifies the whole index without listing it, so no separate
 * `git ls-files --stage` read (or its output bound) is needed, and working-tree-only edits do not change it.
 */
export function stagedFingerprint(buffer: Buffer): string {
  const hash = createHash('sha256');
  const { records, invalid } = statusRecords(buffer);
  // A name that is not UTF-8 is hashed as its exact bytes, so staging such a file still changes the fingerprint.
  const bytes = (text: string, index: number) => Buffer.from(text, invalid.has(index) ? 'latin1' : 'utf8');
  for (let index = 0; index < records.length; index++) {
    const record = records[index], at = index;
    if (!record || !/^[12u] /.test(record)) continue;
    const kind = record[0]!, parsed = fields(record, kind === '1' ? 8 : kind === '2' ? 9 : 10), values = parsed.fields;
    const original = kind === '2' ? records[++index] ?? '' : '';
    const xy = values[1] ?? '';
    if (kind !== 'u' && xy[0] === '.') continue;
    // Worktree-only fields (submodule flags, worktree mode, the Y column) are deliberately excluded.
    const parts = kind === '1' ? [kind, xy[0], values[3], values[4], values[6], values[7], parsed.path]
      : kind === '2' ? [kind, xy[0], values[3], values[4], values[6], values[7], values[8], parsed.path]
      : [kind, xy, values[3], values[4], values[5], values[7], values[8], values[9], parsed.path];
    hash.update(bytes(parts.join('\0'), at));
    if (kind === '2') hash.update('\0').update(bytes(original, index));
    hash.update('\n');
  }
  return hash.digest('hex');
}
