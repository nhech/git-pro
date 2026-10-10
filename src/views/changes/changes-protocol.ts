export type ChangesAction =
  | { type: 'ready'; session: string }
  | { type: 'select'; session: string; keys: string[] }
  | { type: 'toggle'; session: string; key: string }
  | { type: 'action'; session: string; action: 'stage'|'unstage'|'discard'|'diff'|'open'|'history'|'copyPath'|'resolve'|'stageAll'|'unstageAll'|'refresh'; key?: string; keys?: string[] };

const actions = new Set(['stage','unstage','discard','diff','open','history','copyPath','resolve','stageAll','unstageAll','refresh']);
const key = (value: unknown): value is string => typeof value === 'string' && value.length <= 2048 && /^[A-Za-z0-9_=-]+$/.test(value);
const keys = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100 && value.every(key) && new Set(value).size === value.length;

export function parseChangesAction(value: unknown): ChangesAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Changes view request.');
  const item=value as Record<string,unknown>;
  if(typeof item.session!=='string'||!/^[a-f0-9-]{36}$/.test(item.session))throw new Error('Changes view session expired.');
  if(item.type==='ready')return {type:'ready',session:item.session};
  if(item.type==='select'&&keys(item.keys))return {type:'select',session:item.session,keys:item.keys};
  if(item.type==='toggle'&&key(item.key))return {type:'toggle',session:item.session,key:item.key};
  if(item.type==='action'&&typeof item.action==='string'&&actions.has(item.action)){
    if(item.key!==undefined&&!key(item.key))throw new Error('Invalid Changes row identity.');
    if(item.keys!==undefined&&!keys(item.keys))throw new Error('Invalid Changes selection.');
    if(item.key===undefined&&item.keys===undefined&&!['refresh','stageAll','unstageAll'].includes(item.action))throw new Error('Select a changed entry first.');
    return {type:'action',session:item.session,action:item.action as Extract<ChangesAction,{type:'action'}>['action'],...(item.key?{key:item.key as string}:{}),...(item.keys?{keys:item.keys as string[]}:{})};
  }
  throw new Error('Invalid Changes view request.');
}
