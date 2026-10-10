import { validateOid } from '../../security/refs';
import { decode } from '../history/history-parser';
export interface IndexEntry { path: string; mode: string; oid: string; stage: 0|1|2|3 }
export function parseIndex(buffer: Buffer): IndexEntry[] {
  if (buffer.length && buffer.at(-1)!==0) throw new Error('Truncated index records.');
  return decode(buffer).split('\0').filter(Boolean).map(record=>{
    const match = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('Invalid index record.');
    return {mode:match[1]!,oid:validateOid(match[2]!),stage:Number(match[3]) as 0|1|2|3,path:match[4]!};
  });
}
