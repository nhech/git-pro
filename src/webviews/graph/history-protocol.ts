import { validateOid } from '../../security/refs';
import type { HistoryFilters } from '../../git/history/history-builders';
export type HistoryAction = { type: 'ready' | 'more' | 'cancel'; session: string } |
  { type: 'query'; session: string; ref: string; filters: HistoryFilters } |
  { type: 'select'; session: string; oid: string; parent: number } |
  { type: 'compare'; session: string; from: string; to: string } |
  { type: 'comparePage'; session:string; side:'left'|'right';offset:number } |
  { type: 'copy'; session: string; oid:string; field:'hash'|'message' } |
  { type: 'diff'|'workingDiff'; session: string; index: number };
export function parseHistoryAction(value: unknown): HistoryAction {
  if (!value || typeof value !== 'object') throw new Error('Invalid history message.');
  const item = value as Record<string, unknown>;
  if (typeof item.session !== 'string' || item.session.length > 100) throw new Error('Invalid history session.');
  const session = item.session;
  const text = (key: string, max = 500) => {
    const result = item[key]; if (typeof result !== 'string' || result.length > max || result.includes('\0')) throw new Error('Invalid history field.'); return result;
  };
  if (item.type === 'ready' || item.type === 'more' || item.type === 'cancel') return { type: item.type, session };
  if (item.type === 'query') {
    const filters: HistoryFilters = {};
    for (const key of ['author', 'text', 'path', 'from', 'to'] as const) { const result = text(key, key === 'path' ? 4096 : 500); if (result) filters[key] = result; }
    return { type: 'query', session, ref: text('ref',65536), filters };
  }
  if (item.type === 'compare') return { type: 'compare', session, from: text('from'), to: text('to') };
  if(item.type==='comparePage'&&(item.side==='left'||item.side==='right')&&Number.isInteger(item.offset)&&Number(item.offset)>=0&&Number(item.offset)<=1_000_000&&Number(item.offset)%25===0)return {type:'comparePage',session,side:item.side,offset:Number(item.offset)};
  if(item.type==='copy'&&(item.field==='hash'||item.field==='message'))return {type:'copy',session,oid:validateOid(text('oid')),field:item.field};
  if (item.type === 'select' && Number.isInteger(item.parent) && Number(item.parent) >= 0 && Number(item.parent) < 128) return { type: 'select', session, oid: validateOid(text('oid')), parent: Number(item.parent) };
  if ((item.type === 'diff'||item.type==='workingDiff') && Number.isInteger(item.index) && Number(item.index) >= 0 && Number(item.index) < 100_000) return { type: item.type, session, index: Number(item.index) };
  throw new Error('Unknown history action.');
}
