import { validateOid } from '../../security/refs';

export interface HistoryFilters { author?: string; text?: string; path?: string; from?: string; to?: string; follow?: boolean }
export type HistoryReadCommand = { kind: 'history' | 'historyWindow'; tips: readonly string[]; offset: number; limit: number; filters?: HistoryFilters } |
  {kind:'historyLinearPrefix';tip:string;limit:number} |
  {kind:'lineageHistory';tip:string;offset:number;limit:number} |
  {kind:'historyEdges';edges:readonly HistoryEdge[]} |
  {kind:'rangeMessages';base:string;tip:string} |
  {kind:'followHistory';tip:string;path:string;limit:number} |
  {kind:'comparisonCommits';tip:string;exclude:string;offset?:number} | {kind:'comparisonCount';from:string;to:string} |
  { kind: 'commitMetadata' | 'commitMessage' | 'containingRefs'; oid: string } |
  { kind: 'changedFiles' | 'numstat'; from?: string; to: string; paths?: readonly string[] } |
  { kind: 'blame'; path: string; line: number; oid?: string };
function bounded(value: string, maximum = 500): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > maximum) throw new Error('Invalid history filter.');
  return value;
}
export interface HistoryEdge {child:string;parent?:string}
export function historyEdgeInput(edges:readonly HistoryEdge[]):Buffer {
  if(!Array.isArray(edges)||!edges.length||edges.length>1024)throw new Error('History edge batch exceeds 1024.');
  const seen=new Set<string>();
  const lines=edges.map(edge=>{const child=validateOid(edge.child),parent=edge.parent===undefined?'':validateOid(edge.parent),key=`${child}:${parent}`;if(seen.has(key))throw new Error('Duplicate history edge.');seen.add(key);return `${child}${parent?' '+parent:''}\n`;});
  const input=Buffer.from(lines.join(''));if(input.length>128*1024)throw new Error('History edge input exceeds 128 KiB.');return input;
}
export function historyPath(value: string): string {
  bounded(value, 4096);
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes('..')) throw new Error('Invalid history path.');
  return value;
}
function date(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Use a valid YYYY-MM-DD date.');
  return value;
}
export function buildHistoryRead(command: HistoryReadCommand): string[] {
  const prefix = ['--literal-pathspecs', '--no-pager', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false'];
  switch (command.kind) {
    case 'historyLinearPrefix': {
      if (!Number.isInteger(command.limit) || command.limit < 2 || command.limit > 101) throw new Error('Invalid linear history prefix.');
      return [...prefix, 'log', '--no-show-signature', '--no-notes', '-z', '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s', `--max-count=${command.limit}`, validateOid(command.tip), '--'];
    }
    case 'lineageHistory':{
      if(!Number.isInteger(command.offset)||command.offset<0||command.offset>1_000_000||!Number.isInteger(command.limit)||command.limit<1||command.limit>101)throw new Error('Invalid lineage history page.');
      return [...prefix,'log','--topo-order','--no-show-signature','--no-notes','-z','--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%B%x00%ct',`--skip=${command.offset}`,`--max-count=${command.limit}`,validateOid(command.tip),'--'];
    }
    case 'rangeMessages': return [...prefix, 'log', '--reverse', '--no-show-signature', '--no-notes', '-z', '--format=%H%x00%B', '--max-count=201', `${validateOid(command.base)}..${validateOid(command.tip)}`, '--'];
    case 'historyEdges':
      historyEdgeInput(command.edges);
      return [...prefix,'diff-tree','--stdin','--root','--always','-m','-r','--no-ext-diff','--no-textconv','-M','-l1000','--name-status','-z','--format=%x00%H%x00%P%x00','--'];
    case 'followHistory':{
      if(!Number.isInteger(command.limit)||command.limit<1||command.limit>101)throw new Error('Invalid follow history page.');
      return [...prefix,'log','--follow','--first-parent','--topo-order','--no-show-signature','--no-notes','--name-status','-z','--format=%x00%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%B%x00%ct',`--max-count=${command.limit}`,validateOid(command.tip),'--',historyPath(command.path)];
    }
    case 'comparisonCommits':{
      const offset=command.offset??0;if(!Number.isInteger(offset)||offset<0||offset>1_000_000)throw new Error('Invalid comparison page.');
      return [...prefix,'log','--topo-order','--no-show-signature','--no-notes','-z','--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s','--max-count=25',`--skip=${offset}`,'--left-only',`${validateOid(command.tip)}...${validateOid(command.exclude)}`,'--'];
    }
    case 'comparisonCount':return [...prefix,'rev-list','--left-right','--count',`${validateOid(command.from)}...${validateOid(command.to)}`,'--'];
    case 'history': case 'historyWindow': {
      const maximum=command.kind==='historyWindow'?501:101;
      if (!command.tips.length || command.tips.length > 128 || !Number.isInteger(command.offset) || command.offset < 0 || command.offset > 1_000_000 || !Number.isInteger(command.limit) || command.limit < 1 || command.limit > maximum) throw new Error('Invalid history page.');
      const filters = command.filters ?? {};
      if (filters.follow && !filters.path) throw new Error('Rename follow requires one file path.');
      const args = [...prefix, 'log', '--topo-order', '--no-show-signature', '--no-notes', '-z', '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s', `--max-count=${command.limit}`, `--skip=${command.offset}`];
      if (filters.author) args.push(`--author=${bounded(filters.author).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      if (filters.text) args.push('--fixed-strings', `--grep=${bounded(filters.text)}`);
      if (filters.from) args.push(`--since=${date(filters.from)}T00:00:00Z`);
      if (filters.to) args.push(`--until=${date(filters.to)}T23:59:59Z`);
      if (filters.follow) args.push('--follow');
      return [...args, ...command.tips.map(validateOid), '--', ...(filters.path ? [historyPath(filters.path)] : [])];
    }
    case 'commitMetadata': return [...prefix, 'show', '--no-show-signature', '--no-notes', '--no-patch', '-z', '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s', `${validateOid(command.oid)}^{commit}`, '--'];
    case 'commitMessage': return [...prefix, 'show', '--no-show-signature', '--no-notes', '-s', '--format=%B', validateOid(command.oid), '--'];
    case 'containingRefs': return [...prefix, 'for-each-ref', `--contains=${validateOid(command.oid)}`, '--format=%(refname)%00', 'refs/heads/', 'refs/remotes/', 'refs/tags/'];
    case 'changedFiles': case 'numstat': {
      const output = command.kind === 'changedFiles' ? '--name-status' : '--numstat';
      const paths = (command.paths ?? []).map(historyPath);
      const args = command.from ? ['diff', validateOid(command.from), validateOid(command.to)] : ['diff-tree', '--root', '--no-commit-id', '-r', validateOid(command.to)];
      return [...prefix, ...args, '--no-ext-diff', '--no-textconv', '-M', '-l1000', output, '-z', '--', ...paths];
    }
    case 'blame': {
      if (!Number.isInteger(command.line) || command.line < 1 || command.line > 10_000_000) throw new Error('Invalid blame line.');
      // Like every other content read, never run the repository's textconv programs.
      return [...prefix, 'blame', '--no-textconv', '--line-porcelain', '-L', `${command.line},${command.line}`, ...(command.oid ? [validateOid(command.oid)] : []), '--', historyPath(command.path)];
    }
  }
}
