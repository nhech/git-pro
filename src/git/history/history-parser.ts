import { validateOid } from '../../security/refs';

export interface HistoryCommit { oid: string; parents: readonly string[]; author: string; email: string; timestamp: number; subject: string }
/** A single-tip chain is the unique prefix of every valid topological walk. */
export function verifiedLinearPrefix(commits: readonly HistoryCommit[], tip: string, size: number): boolean {
  if (!Number.isInteger(size) || size < 1 || size > 100 || !commits.length || commits.length > size + 1 || commits[0]!.oid !== tip) return false;
  if (new Set(commits.map(commit => commit.oid)).size !== commits.length) return false;
  for (let index = 0; index < Math.min(size, commits.length); index++) {
    const commit = commits[index]!, next = commits[index + 1];
    if (next ? commit.parents.length !== 1 || commit.parents[0] !== next.oid : commit.parents.length !== 0) return false;
  }
  return true;
}
export interface ChangedFile { path: string; originalPath?: string; status: string }
export interface FileStat { path: string; originalPath?: string; added: number | null; removed: number | null }
export function decode(buffer: Buffer): string { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
export function parseComparisonCounts(buffer:Buffer):{left:number;right:number}{
  const match=/^(\d+)\s+(\d+)$/.exec(decode(buffer).trim());
  if(!match||!Number.isSafeInteger(Number(match[1]))||!Number.isSafeInteger(Number(match[2])))throw new Error('Invalid comparison commit counts.');
  return{left:Number(match[1]),right:Number(match[2])};
}
function nulFields(buffer: Buffer): string[] {
  if (!buffer.length) return [];
  if (buffer.at(-1) !== 0) throw new Error('Truncated Git records.');
  return decode(buffer).slice(0, -1).split('\0');
}
export function parseHistory(buffer: Buffer): HistoryCommit[] {
  const fields = nulFields(buffer); if (fields.length % 6) throw new Error('Unsupported commit metadata framing.');
  const result: HistoryCommit[] = [];
  for (let i = 0; i < fields.length; i += 6) {
    const [oid, parentText, author, email, time, subject] = fields.slice(i, i + 6) as [string, string, string, string, string, string];
    if (!/^\d+$/.test(time) || !Number.isSafeInteger(Number(time))) throw new Error('Invalid commit timestamp.');
    result.push(Object.freeze({ oid: validateOid(oid), parents: Object.freeze(parentText ? parentText.split(' ').map(validateOid) : []), author, email, timestamp: Number(time), subject }));
  }
  return result;
}
/** Output of `git log -z --format=%H%x00%B`: a commit ID and its raw message, each record NUL-terminated. */
export function parseRangeMessages(buffer: Buffer): { oid: string; message: string }[] {
  const fields = nulFields(buffer); if (fields.length % 2) throw new Error('Unsupported commit message framing.');
  const result: { oid: string; message: string }[] = [];
  for (let i = 0; i < fields.length; i += 2) result.push({ oid: validateOid(fields[i]!), message: fields[i + 1]! });
  return result;
}
export function parseFollowHistory(buffer:Buffer):{commit:HistoryCommit;message:string;committerTimestamp:number;file:ChangedFile}[]{
  const fields=nulFields(buffer),result:{commit:HistoryCommit;message:string;committerTimestamp:number;file:ChangedFile}[]=[];let index=0;
  while(index<fields.length){
    if(fields[index++]!=='')throw new Error('Invalid follow record boundary.');
    if(index+8>fields.length)throw new Error('Truncated follow metadata.');
    const metadata=fields.slice(index,index+6),message=fields[index+6]!,committer=fields[index+7]!;index+=8;
    const commit=parseHistory(Buffer.from(metadata.join('\0')+'\0'))[0]!;
    if(!/^\d+$/.test(committer)||!Number.isSafeInteger(Number(committer)))throw new Error('Invalid follow committer timestamp.');
    const status=(fields[index++]??'').replace(/^\n/,'');if(!/^(?:[ACDMRTUXB]|[RC]\d{1,3})$/.test(status))throw new Error('Invalid follow file status.');
    const first=fields[index++];if(!first)throw new Error('Missing follow path.');
    let file:ChangedFile={status,path:first};if(status.startsWith('R')||status.startsWith('C')){const target=fields[index++];if(!target)throw new Error('Missing follow rename target.');file={status,path:target,originalPath:first};}
    if(index<fields.length&&fields[index]!=='')throw new Error('Unsupported multi-file follow record.');
    result.push({commit,message,committerTimestamp:Number(committer),file});
  }
  return result;
}
export function parseChangedFiles(buffer: Buffer): ChangedFile[] {
  const fields = nulFields(buffer); const result: ChangedFile[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++]!;
    if (!/^(?:[ACDMRTUXB]|[RC]\d{1,3})$/.test(status)) throw new Error('Invalid changed-file status.');
    const first = fields[i++]; if (!first) throw new Error('Missing changed-file path.');
    if (status.startsWith('R') || status.startsWith('C')) {
      const second = fields[i++]; if (!second) throw new Error('Missing rename target.');
      result.push({ status, originalPath: first, path: second });
    } else result.push({ status, path: first });
  }
  return result;
}
export function parseNumstat(buffer: Buffer): FileStat[] {
  const fields = nulFields(buffer); const result: FileStat[] = [];
  const count = (value: string): number | null => {
    if (value === '-') return null;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid numstat count.');
    return Number(value);
  };
  for (let i = 0; i < fields.length;) {
    const record = fields[i++]!; const a = record.indexOf('\t'), b = record.indexOf('\t', a + 1);
    if (a < 0 || b < 0) throw new Error('Invalid numstat framing.');
    const added = count(record.slice(0, a)), removed = count(record.slice(a + 1, b));
    const file = record.slice(b + 1);
    if (file) result.push({ path: file, added, removed });
    else {
      const originalPath = fields[i++], target = fields[i++];
      if (!originalPath || !target) throw new Error('Truncated numstat rename.');
      result.push({ path: target, originalPath, added, removed });
    }
  }
  return result;
}
