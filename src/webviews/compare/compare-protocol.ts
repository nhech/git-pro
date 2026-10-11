import { validateOid } from '../../security/refs';

/** Webview → host (design §3.11). The webview names rows by index into the host's captured file list and by loaded commit OIDs only, never by path or ref. */
export type CompareAction = { type: 'ready'; session: string } | { type: 'refresh'; session: string } |
  { type: 'swap' | 'openAll' | 'allChanges'; session: string; revision: number } |
  { type: 'page'; session: string; revision: number; side: 'left' | 'right'; offset: number } |
  { type: 'selectCommit' | 'copyRevision' | 'showInHistory'; session: string; revision: number; oid: string } |
  { type: 'filesMode'; session: string; revision: number; mode: 'fork' | 'tips' } |
  { type: 'filesPage'; session: string; revision: number; offset: number } |
  { type: 'diff' | 'localDiff' | 'openFile'; session: string; revision: number; index: number } |
  { type: 'getFromBranch'; session: string; revision: number; indexes: number[] };
const index = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) < 1_000_000;
/** Strict: unknown types and malformed fields throw; fields a type does not name are dropped. */
export function parseCompareAction(value: unknown): CompareAction {
  if (!value || typeof value !== 'object') throw new Error('Invalid Compare message.');
  const item = value as Record<string, unknown>;
  if (typeof item.session !== 'string' || !item.session || item.session.length > 100) throw new Error('Invalid Compare session.');
  const session = item.session;
  if (item.type === 'ready') return { type: 'ready', session };
  if (item.type === 'refresh') return { type: 'refresh', session };
  if (!Number.isInteger(item.revision) || Number(item.revision) < 0 || Number(item.revision) > 1_000_000_000) throw new Error('Invalid Compare revision.');
  const revision = Number(item.revision);
  switch (item.type) {
    case 'swap': case 'openAll': case 'allChanges': return { type: item.type, session, revision };
    case 'page':
      if ((item.side === 'left' || item.side === 'right') && index(item.offset) && item.offset % 25 === 0) return { type: 'page', session, revision, side: item.side, offset: item.offset };
      break;
    case 'selectCommit': case 'copyRevision': case 'showInHistory':
      if (typeof item.oid === 'string') return { type: item.type, session, revision, oid: validateOid(item.oid) };
      break;
    case 'filesMode':
      if (item.mode === 'fork' || item.mode === 'tips') return { type: 'filesMode', session, revision, mode: item.mode };
      break;
    case 'filesPage':
      if (index(item.offset) && item.offset % 200 === 0) return { type: 'filesPage', session, revision, offset: item.offset };
      break;
    case 'diff': case 'localDiff': case 'openFile':
      if (index(item.index)) return { type: item.type, session, revision, index: item.index };
      break;
    case 'getFromBranch': {
      const indexes = item.indexes;
      if (Array.isArray(indexes) && indexes.length >= 1 && indexes.length <= 100 && indexes.every(index) && new Set(indexes).size === indexes.length) return { type: 'getFromBranch', session, revision, indexes: [...indexes] };
      break;
    }
  }
  throw new Error('Unknown Compare action.');
}
