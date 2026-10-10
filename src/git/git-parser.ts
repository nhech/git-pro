import { createHash } from 'node:crypto';
export type ChangeGroup = 'staged' | 'working' | 'untracked' | 'conflicts';
export interface FileChange { readonly path: string; readonly originalPath?: string; readonly status: string; readonly group: ChangeGroup }
export interface StatusSnapshot {
  readonly head: string | undefined; readonly oid: string | undefined; readonly upstream: string | undefined;
  readonly ahead: number | undefined; readonly behind: number | undefined; readonly changes: readonly FileChange[];
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
export function sameStatus(a: StatusSnapshot, b: StatusSnapshot): boolean {
  if (a === b) return true;
  if (a.head !== b.head || a.oid !== b.oid || a.upstream !== b.upstream || a.ahead !== b.ahead || a.behind !== b.behind || a.changes.length !== b.changes.length) return false;
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
  // Never alias unsupported filename bytes through UTF-8 replacement characters.
  const records = new TextDecoder('utf-8', { fatal: true }).decode(buffer).split('\0');
  let head: string | undefined, oid: string | undefined, upstream: string | undefined,
    ahead: number | undefined, behind: number | undefined;
  const changes: FileChange[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('# branch.head ')) head = record.slice(14);
    else if (record.startsWith('# branch.oid ')) oid = record.slice(13) === '(initial)' ? undefined : record.slice(13);
    else if (record.startsWith('# branch.upstream ')) upstream = record.slice(18);
    else if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (!match) throw new Error('Malformed ahead/behind record.');
      ahead = Number(match[1]); behind = Number(match[2]);
    } else if (record.startsWith('? ')) changes.push({ path: record.slice(2), group: 'untracked', status: '?' });
    else if (record.startsWith('! ') || record.startsWith('# ')) continue;
    else if (/^[12u] /.test(record)) {
      const parsed = fields(record, record[0] === '1' ? 8 : record[0] === '2' ? 9 : 10);
      const xy = parsed.fields[1];
      if (!xy || xy.length !== 2 || !parsed.path) throw new Error('Malformed change record.');
      let originalPath: string | undefined;
      if (record[0] === '2') { originalPath = records[++index]; if (!originalPath) throw new Error('Missing rename source.'); }
      const renamed = originalPath === undefined ? {} : { originalPath };
      if (record[0] === 'u') changes.push({ path: parsed.path, status: xy, group: 'conflicts', ...renamed });
      else {
        if (xy[0] !== '.') changes.push({ path: parsed.path, status: xy[0]!, group: 'staged', ...renamed });
        if (xy[1] !== '.') changes.push({ path: parsed.path, status: xy[1]!, group: 'working', ...renamed });
      }
    } else throw new Error('Unsupported Git status record.');
  }
  return Object.freeze({ head, oid, upstream, ahead, behind, changes: Object.freeze(changes.map(change => Object.freeze(change))) });
}
/**
 * Digest of every index entry that differs from HEAD, taken from the same `git status --porcelain=v2 -z`
 * bytes. Together with HEAD's OID it identifies the whole index without listing it, so no separate
 * `git ls-files --stage` read (or its output bound) is needed, and working-tree-only edits do not change it.
 */
export function stagedFingerprint(buffer: Buffer): string {
  const hash = createHash('sha256');
  const records = new TextDecoder('utf-8', { fatal: true }).decode(buffer).split('\0');
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || !/^[12u] /.test(record)) continue;
    const kind = record[0]!, parsed = fields(record, kind === '1' ? 8 : kind === '2' ? 9 : 10), values = parsed.fields;
    const original = kind === '2' ? records[++index] ?? '' : '';
    const xy = values[1] ?? '';
    if (kind !== 'u' && xy[0] === '.') continue;
    // Worktree-only fields (submodule flags, worktree mode, the Y column) are deliberately excluded.
    const parts = kind === '1' ? [kind, xy[0], values[3], values[4], values[6], values[7], parsed.path]
      : kind === '2' ? [kind, xy[0], values[3], values[4], values[6], values[7], values[8], parsed.path, original]
      : [kind, xy, values[3], values[4], values[5], values[7], values[8], values[9], parsed.path];
    hash.update(parts.join('\0')).update('\n');
  }
  return hash.digest('hex');
}
