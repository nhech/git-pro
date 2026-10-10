import type { RepositoryRegistry, RepositoryDescriptor } from '../../repositories/repository-registry';
import { GitExecutor } from '../git-executor';
import { GitFailure } from '../git-error-parser';
import type { ReadCommand } from '../command-builders';
import { buildHistoryRead, historyPath, type HistoryFilters } from './history-builders';
import { parseHistory, verifiedLinearPrefix, parseChangedFiles, parseNumstat, parseComparisonCounts, decode, type HistoryCommit } from './history-parser';
import { initialFileCursor, advanceFileCursor, parseLineageHistory, parseHistoryEdges, type FileCursor } from './file-lineage';
import { parseBlame } from './blame-parser';
import { parseStatus } from '../git-parser';
import { validateOid } from '../../security/refs';
import { ReadScheduler } from '../../utils/read-scheduler';
import { PathPolicy, canonicalFilePath, containsPath } from '../../security/paths';
import { boundedFile } from '../../utils/bounded-file';
import { lstat } from 'node:fs/promises';

export interface PinnedHistory { repositoryId: string; tips: readonly string[]; filters: Readonly<HistoryFilters>;refs?:readonly {name:string;oid:string}[] }
export interface HistoryPage { commits: readonly HistoryCommit[]; offset: number; hasMore: boolean; nextOffset: number }
export class HistoryService {
  private readonly scheduler = new ReadScheduler();
  private fileQueries=new WeakMap<PinnedHistory,{repository:RepositoryDescriptor;cursor?:FileCursor}>();
  private track(query:PinnedHistory):PinnedHistory {this.policy.checkTrust();this.fileQueries.set(query,{repository:this.repository(query.repositoryId)});return query;}
  constructor(private readonly registry: RepositoryRegistry, private readonly executor: GitExecutor, private readonly policy: PathPolicy) {}
  root(id:string):string{return this.repository(id).root;}
  private repository(id: string): RepositoryDescriptor {
    const repo = this.registry.list().find(item => item.id === id); if (!repo) throw new Error('Repository is no longer open.'); return repo;
  }
  private read(id: string, command: ReadCommand, external?: AbortSignal): Promise<Buffer> {
    const repo = this.repository(id);
    return this.scheduler.run(async signal => {
      const result = await this.executor.read(repo.root, command, { signal, maxOutputBytes: 5 * 1024 * 1024 });
      if (this.repository(id) !== repo) throw new Error('Repository changed during history read.'); return result.stdout;
    }, external);
  }
  async pin(id: string, ref = 'HEAD', filters: HistoryFilters = {}, signal?: AbortSignal): Promise<PinnedHistory> {
    buildHistoryRead({ kind: 'history', tips: ['0'.repeat(40)], offset: 0, limit: 101, filters });
    const names=ref.split(/\r?\n/).map(name=>name.trim()).filter(Boolean);
    if(names.length>1){
      if(names.length>128||ref.length>65536||filters.follow)throw new Error('Choose at most 128 refs; rename-follow requires one ref.');
      const refs:{name:string;oid:string}[]=[],unique=[...new Set(names)];
      for(let start=0;start<unique.length;start+=8)refs.push(...await Promise.all(unique.slice(start,start+8).map(async name=>({name,oid:validateOid(decode(await this.read(id,{kind:'ref',ref:name},signal)).trim())}))));
      if (signal?.aborted) throw new Error('History read cancelled.');
      return this.track(Object.freeze({repositoryId:id,tips:Object.freeze([...new Set(refs.map(item=>item.oid))]),filters:Object.freeze({...filters}),refs:Object.freeze(refs.map(item=>Object.freeze(item)))}));
    }
    ref=names[0]??'HEAD';
    let oid: string | undefined;
    if (ref === 'HEAD') {
      const resolved = decode(await this.read(id, { kind: 'historyHead' }, signal)).trim();
      if (resolved) oid = validateOid(resolved);
      else {
        // Quiet failure is not proof of an unborn branch. A corrupt HEAD/object
        // or repository must still fail the existing porcelain status read.
        const output = await this.read(id, { kind: 'status' }, signal);
        const status = parseStatus(output);
        if (status.oid) {
          // Status can print a syntactically valid but missing detached object.
          // Re-resolve only this rare fallback; never accept its header as proof.
          const refreshed = decode(await this.read(id, { kind: 'historyHead' }, signal)).trim();
          if (!refreshed) throw new Error('Unable to resolve the repository HEAD.');
          oid = validateOid(refreshed);
        }
        else if (!output.toString('utf8').split('\0').includes('# branch.oid (initial)') || !status.head || status.head === '(detached)') throw new Error('Unable to resolve the repository HEAD.');
      }
    } else oid = validateOid(decode(await this.read(id, { kind: 'ref', ref }, signal)).trim());
    if (signal?.aborted) throw new Error('History read cancelled.');
    if (oid) buildHistoryRead({ kind: 'history', tips: [oid], offset: 0, limit: 101, filters });
    return this.track(Object.freeze({ repositoryId: id, tips: Object.freeze(oid ? [oid] : []), filters: Object.freeze({ ...filters }),refs:Object.freeze(oid?[Object.freeze({name:ref,oid})]:[]) }));
  }
  async page(query: PinnedHistory, offset = 0, signal?: AbortSignal, size = 100): Promise<HistoryPage> {
    if (!Number.isInteger(size) || size < 1 || size > 100) throw new Error('History page size must be 1–100.');
    this.repository(query.repositoryId); this.policy.checkTrust();
    if (signal?.aborted) throw new Error('History read cancelled.');
    if (!query.tips.length) return { commits: [], offset, hasMore: false, nextOffset: offset };
    const filters = query.filters;
    if (offset === 0 && query.tips.length === 1 && (query.refs?.length ?? 0) <= 1 && !filters.author && !filters.text && !filters.path && !filters.from && !filters.to && !filters.follow && this.fileQueries.get(query)?.repository === this.repository(query.repositoryId)) {
      let output: Buffer | undefined;
      try { output = await this.read(query.repositoryId, { kind: 'historyLinearPrefix', tip: query.tips[0]!, limit: size + 1 }, signal); }
      catch (error) { if ((error as { kind?: string }).kind !== 'output-limit') throw error; }
      this.checkPinnedQuery(query);
      if (signal?.aborted) throw new Error('History read cancelled.');
      // Default-order speculation can encounter metadata outside the requested
      // topo page. Reject that optimization, while preserving errors from the
      // original page and cancellation/ownership checks from either read.
      let prefix: HistoryCommit[] | undefined;
      if (output) { try { prefix = parseHistory(output); } catch { /* Use the original topo recipe. */ } }
      if (prefix && verifiedLinearPrefix(prefix, query.tips[0]!, size)) return { commits: Object.freeze(prefix.slice(0, size)), offset, hasMore: prefix.length > size, nextOffset: Math.min(prefix.length, size) };
    }
    const parsed = parseHistory(await this.read(query.repositoryId, { kind: 'history', tips: query.tips, offset, limit: size + 1, filters: query.filters }, signal));
    return { commits: Object.freeze(parsed.slice(0, size)), offset, hasMore: parsed.length > size, nextOffset: offset + Math.min(parsed.length, size) };
  }
  /** Additional More clicks consume this acquired snapshot; each new window is a fresh Git read. */
  checkPinnedQuery(query:PinnedHistory):void{
    this.policy.checkTrust();const repo=this.repository(query.repositoryId);
    if(this.fileQueries.get(query)?.repository!==repo)throw new Error('History view expired. Refresh history.');
  }
  async window(query:PinnedHistory,offset:number,signal?:AbortSignal,capacity=500,fallbackSize=100):Promise<HistoryPage>{
    if(!Number.isInteger(offset)||offset<0||offset>1_000_000||!Number.isInteger(capacity)||capacity<1||capacity>500||!Number.isInteger(fallbackSize)||fallbackSize<1||fallbackSize>100||query.filters.follow)throw new Error('Invalid ordinary history window.');
    this.checkPinnedQuery(query);if(signal?.aborted)throw new Error('History read cancelled.');
    if(!query.tips.length)return{commits:[],offset,hasMore:false,nextOffset:offset};
    const ordinaryPage=async()=>{
      this.checkPinnedQuery(query);
      const page=await this.page(query,offset,signal,Math.min(capacity,fallbackSize));
      this.checkPinnedQuery(query);if(signal?.aborted)throw new Error('History read cancelled.');
      return page;
    };
    let output:Buffer;
    try{output=await this.read(query.repositoryId,{kind:'historyWindow',tips:query.tips,offset,limit:capacity+1,filters:query.filters},signal);}
    catch(error){if((error as {kind?:string}).kind==='output-limit')return ordinaryPage();throw error;}
    this.checkPinnedQuery(query);if(signal?.aborted)throw new Error('History read cancelled.');
    let parsed:HistoryCommit[];
    try{parsed=parseHistory(output);}catch{return ordinaryPage();}
    const bytes=2*Buffer.byteLength(JSON.stringify(parsed))+parsed.reduce((n,c)=>n+256+c.parents.length*32,0);
    const returned=bytes<=2*1024*1024?capacity:Math.min(capacity,fallbackSize);
    return{commits:Object.freeze(parsed.slice(0,returned)),offset,hasMore:parsed.length>returned,nextOffset:offset+Math.min(parsed.length,returned)};
  }
  /** The raw message alone: copying it must not pay for the five reads a full details view needs. */
  async message(id: string, oid: string, signal?: AbortSignal): Promise<string> {
    validateOid(oid);
    return decode(await this.read(id, { kind: 'commitMessage', oid }, signal));
  }
  async details(id: string, oid: string, parent = 0, signal?: AbortSignal) {
    validateOid(oid);
    const commits = parseHistory(await this.read(id, { kind: 'commitMetadata', oid }, signal));
    const commit = commits[0]; if (!commit || commit.oid !== oid) throw new Error('Commit no longer available.');
    if (!Number.isInteger(parent) || parent < 0 || parent >= Math.max(1, commit.parents.length)) throw new Error('Choose a valid merge parent.');
    const from = commit.parents[parent];
    // A commit too large to list (a vendored tree, a generated message) still shows its metadata and whatever fits the bound.
    const bounded = (command: ReadCommand) => this.read(id, command, signal).catch((error: unknown) => {
      if (error instanceof GitFailure && error.kind === 'output-limit') return undefined; throw error;
    });
    const [message, files, stats] = await Promise.all([
      bounded({ kind: 'commitMessage', oid }),
      bounded({ kind: 'changedFiles', to: oid, ...(from ? { from } : {}) }),
      bounded({ kind: 'numstat', to: oid, ...(from ? { from } : {}) })
    ]);
    return { commit, parent: from, message: message ? decode(message) : commit.subject, files: files ? parseChangedFiles(files) : [], stats: files && stats ? parseNumstat(stats) : [],
      ...(message ? {} : { messageOmitted: true }), ...(files ? {} : { filesOmitted: true }) };
  }
  /** Separate from details: `for-each-ref --contains` walks history per ref and can outlast the read timeout in large repositories. */
  async containingRefs(id: string, oid: string, signal?: AbortSignal): Promise<string[]> {
    validateOid(oid);
    return decode(await this.read(id, { kind: 'containingRefs', oid }, signal)).split('\0').map(ref => ref.trim()).filter(Boolean);
  }
  async filePage(query: PinnedHistory, offset: number, currentPath: string, signal?: AbortSignal, size = 100) {
    if (!query.filters.follow || !query.filters.path) throw new Error('Rename-follow query requires a file.');
    if(!Number.isInteger(size)||size<1||size>100||!Number.isInteger(offset)||offset<0)throw new Error('Invalid file history page.');
    buildHistoryRead({kind:'history',tips:['0'.repeat(40)],offset:0,limit:1,filters:query.filters});this.repository(query.repositoryId);this.policy.checkTrust();if(signal?.aborted)throw new Error('History read cancelled.');
    if(query.tips.length>1)throw new Error('Rename-follow requires one pinned tip.');
    const owned=this.fileQueries.get(query),repo=this.repository(query.repositoryId),file=historyPath(currentPath);
    if(!owned||owned.repository!==repo)throw new Error('File history cursor is not owned by this repository session.');
    if(file!==query.filters.path)throw new Error('File history cursor path changed. Refresh history.');
    if(!query.tips[0])return{commits:[],offset,nextOffset:offset,hasMore:false,paths:[],nextPath:file,nextQuery:query,scanned:0};
    const cursor=owned.cursor??initialFileCursor(query.tips[0],file);
    if(offset!==cursor.displayOffset)throw new Error('File history cursor offset changed. Refresh history.');
    const result=await advanceFileCursor(cursor,query.filters,size,
      async scanOffset=>parseLineageHistory(await this.read(query.repositoryId,{kind:'lineageHistory',tip:cursor.tip,offset:scanOffset,limit:101},signal)),
      async edges=>parseHistoryEdges(await this.read(query.repositoryId,{kind:'historyEdges',edges},signal),edges),signal);
    if(this.repository(query.repositoryId)!==repo)throw new Error('Repository changed during file history.');this.policy.checkTrust();
    const nextQuery:PinnedHistory=Object.freeze({...query});this.fileQueries.set(nextQuery,{repository:repo,cursor:result.cursor});
    return{commits:result.commits,offset,nextOffset:result.cursor.displayOffset,hasMore:result.hasMore,paths:result.paths,nextPath:file,nextQuery,scanned:result.scanned};
  }
  async compare(id: string, from: string, to: string, signal?: AbortSignal) {
    const [left, right] = await Promise.all([this.read(id, { kind: 'ref', ref: from }, signal), this.read(id, { kind: 'ref', ref: to }, signal)]);
    const a = validateOid(decode(left).trim()), b = validateOid(decode(right).trim());
    const [files, stats,leftCommits,rightCommits,counts] = await Promise.all([this.read(id, { kind: 'changedFiles', from: a, to: b }, signal), this.read(id, { kind: 'numstat', from: a, to: b }, signal),this.read(id,{kind:'comparisonCommits',tip:a,exclude:b},signal),this.read(id,{kind:'comparisonCommits',tip:b,exclude:a},signal),this.read(id,{kind:'comparisonCount',from:a,to:b},signal)]);
    const count=parseComparisonCounts(counts);
    return { from: a, to: b, files: parseChangedFiles(files), stats: parseNumstat(stats),leftCommits:parseHistory(leftCommits),rightCommits:parseHistory(rightCommits),leftCount:count.left,rightCount:count.right,leftOffset:0,rightOffset:0 };
  }
  async comparisonPage(id:string,tip:string,exclude:string,offset:number,signal?:AbortSignal):Promise<HistoryCommit[]>{return parseHistory(await this.read(id,{kind:'comparisonCommits',tip,exclude,offset},signal));}
  async blame(id: string, file: string, line: number, signal?: AbortSignal) {
    const repo = this.repository(id); const absolute = await this.policy.authorizeFile(repo.root, file);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 5 * 1024 * 1024 || (await this.registry.resolveFile(absolute))?.id !== id) throw new Error('Blame requires a bounded regular file in this repository.');
    return parseBlame(await this.read(id, { kind: 'blame', path: file, line }, signal));
  }
  async revision(id: string, oid: string | undefined, file: string, signal?: AbortSignal): Promise<Buffer> {
    historyPath(file); this.repository(id); this.policy.checkTrust();
    if (!oid) return Buffer.alloc(0);
    validateOid(oid);
    const entry = decode(await this.read(id, { kind: 'tree', oid, path: file }, signal));
    if (!entry) return Buffer.alloc(0);
    const match = /^100(?:644|755) blob ([a-f0-9]{40,64})\t/.exec(entry);
    if (!match) throw new Error('Text diff is unavailable for symlinks or submodules.');
    const blob = validateOid(match[1]!);
    const size = Number(decode(await this.read(id, { kind: 'blobSize', oid: blob }, signal)).trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > 5 * 1024 * 1024) throw new Error('Revision exceeds the 5 MiB text diff limit.');
    const content = await this.read(id, { kind: 'blob', oid: blob }, signal);
    if (content.includes(0)) throw new Error('Binary revision cannot be opened as text.');
    decode(content); return content;
  }
  async workingRevision(id:string,file:string,signal?:AbortSignal):Promise<Buffer>{
    historyPath(file);const repo=this.repository(id),absolute=await this.policy.authorizeFile(repo.root,file);
    const canonical=await canonicalFilePath(absolute);
    if(file.split(/[\\/]/).some(part=>/^\.git(?:[ .:]|$)/i.test(part))||containsPath(repo.gitDir,canonical)||containsPath(repo.commonDir,canonical))throw new Error('Git metadata cannot be compared as a working file.');
    if((await this.registry.resolveFile(absolute))?.id!==id)throw new Error('Working file belongs to another repository.');
    if(signal?.aborted)throw new Error('Working revision cancelled.');
    const info=await lstat(absolute).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;});
    if(!info){if(this.repository(id)!==repo)throw new Error('Repository changed during working revision.');return Buffer.alloc(0);}
    if(!info.isFile()||info.isSymbolicLink()||info.size>5*1024*1024)throw new Error('Working comparison requires a bounded regular text file.');
    const content=await boundedFile(absolute);
    if(await canonicalFilePath(absolute)!==canonical||(await lstat(absolute)).isSymbolicLink())throw new Error('Working file changed ownership during comparison.');
    if(signal?.aborted||this.repository(id)!==repo)throw new Error('Working revision expired.');this.policy.checkTrust();
    if(content.includes(0))throw new Error('Binary working revision cannot be opened as text.');decode(content);return content;
  }
  dispose(): void { this.fileQueries=new WeakMap();this.scheduler.dispose(); }
}
