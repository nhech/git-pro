import { historyHtml } from './history-html';
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { HistoryService, type PinnedHistory, type HistoryPage } from '../../git/history/history.service';
import type { ChangedFile, HistoryCommit } from '../../git/history/history-parser';
import { RevisionProvider } from '../../documents/revision-provider';
import { parseHistoryAction } from './history-protocol';
import { layoutGraph, type GraphRow } from './graph-layout';
import { redact } from '../../security/redaction';

export class HistoryPanel implements vscode.Disposable {
  private readonly panels = new Set<vscode.WebviewPanel>();
  constructor(private readonly context: vscode.ExtensionContext, private readonly history: HistoryService, private readonly revisions: RevisionProvider) {}
  get activePanelCount():number{return this.panels.size;}
  open(repositoryId: string, path?: string,initialRef='HEAD',selectTip=false): void {
    const panel = vscode.window.createWebviewPanel('gitPro.history', path ? 'Git Pro: File History' : 'Git Pro: History & Compare', vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')], retainContextWhenHidden: false });
    this.panels.add(panel);
    const session = randomUUID(), nonce = randomUUID().replace(/-/g, '');
    const resource = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name)).toString();
    let query: PinnedHistory | undefined, offset = 0, hasMore = false, commits: HistoryCommit[] = [], rows: GraphRow[] = [], continuation: readonly (string | null)[] = [];
    let selected: string | undefined, comparison: { from?: string; to: string; files: readonly ChangedFile[] } | undefined;
    const comparisonCommits=new Set<string>();
    let sidePages:Awaited<ReturnType<HistoryService['compare']>>|undefined;
    let comparisonInputs:{from:string;to:string}|undefined;
    let detailMessage:Record<string,unknown>|undefined;
    let queryRef=initialRef,lastScanned=0,pageLoaded=false,limitReached=false;
    const updateSideMembership=()=>{comparisonCommits.clear();if(sidePages)for(const commit of [...sidePages.leftCommits,...sidePages.rightCommits])comparisonCommits.add(commit.oid);};
    let request: AbortController | undefined, generation = 0, disposed = false;
    let refsLookup: AbortController | undefined;
    let diffBusy = false,requestBusy=false;
    let currentPath = path; const historicalPaths = new Map<string, string>();
    let followQuery: PinnedHistory | undefined;
    let buffered:HistoryPage|undefined;
    type InitialPage = { query: PinnedHistory; page: HistoryPage; size: number };
    let initialController: AbortController | undefined;
    let initialAcquisition: Promise<InitialPage | { error: unknown }> | undefined;
    const pageSize = () => {
      const configured = vscode.workspace.getConfiguration('gitPro', vscode.Uri.file(this.history.root(repositoryId))).get<number>('graph.pageSize', 100);
      return Number.isFinite(configured) ? Math.max(25, Math.min(100, Math.round(configured))) : 100;
    };
    const post = (value: Record<string, unknown>) => panel.webview.postMessage({ ...value, session });
    const postPage = () => post({ type:'page',commits,rows,hasMore,limitReached,tips:query!.tips,refs:query!.refs??[],filters:query!.filters,ref:queryRef,fileHistory:Boolean(query!.filters.follow),scanned:lastScanned });
    /**
     * Containing refs arrive after the details and outside the busy request: `for-each-ref --contains`
     * can outlast the read timeout in large repositories, and that must neither block nor fail the details.
     */
    const lookupRefs = (oid: string) => {
      refsLookup?.abort(); const controller = refsLookup = new AbortController();
      void Promise.resolve().then(() => this.history.containingRefs(repositoryId, oid, controller.signal))
        .then((refs): Record<string, unknown> => ({ refs }), (error: unknown) => ({ refsError: redact(typeof (error as Error | undefined)?.message === 'string' ? (error as Error).message : String(error)) }))
        .then(async result => {
          if (disposed || controller.signal.aborted || selected !== oid || !detailMessage) return;
          refsLookup = undefined;
          // A recreated renderer receives the stored message, so it must carry the result too.
          detailMessage = { ...detailMessage, details: { ...detailMessage.details as Record<string, unknown>, ...result } };
          await post({ type: 'refs', oid, ...result });
        }).catch(() => undefined);
    };
    const clearQuery = () => {
      refsLookup?.abort(); refsLookup = undefined;
      query = undefined; offset = 0; hasMore = false; commits = []; rows = []; continuation = [];
      selected = undefined; comparison = undefined; buffered = undefined; detailMessage = undefined;
      sidePages = undefined; comparisonInputs = undefined; comparisonCommits.clear();
      currentPath = undefined; followQuery = undefined; historicalPaths.clear();
      lastScanned = 0; pageLoaded = false; limitReached = false;
    };
    const page = async (signal: AbortSignal, current: number, initial?: InitialPage) => {
      if (disposed || current !== generation || signal.aborted) return;
      if (!query) throw new Error('Refresh history first.');
      if (commits.length >= 2000) throw new Error('2000 commits loaded. Narrow filters or refresh to release memory.');
      const size = pageSize();
      const followed = query.filters.follow && currentPath ? await this.history.filePage(followQuery ?? query, offset, currentPath, signal,size) : undefined;
      let result:HistoryPage|undefined=followed;
      if (initial && initial.query === query && initial.size === size) {
        this.history.checkPinnedQuery(query);
        if (signal.aborted) return;
        result = initial.page;
      }
      if(!result){
        if(pageLoaded&&!query.filters.follow){
          this.history.checkPinnedQuery(query);
          if(!buffered){const batch=await this.history.window(query,offset,signal,Math.min(500,2000-commits.length),size);if(disposed||current!==generation||signal.aborted)return;buffered=batch;}
          const start=offset-buffered.offset,items=buffered.commits.slice(start,start+size),nextOffset=offset+items.length;
          result={commits:items,offset,nextOffset,hasMore:nextOffset<buffered.nextOffset||buffered.hasMore};
          if(nextOffset>=buffered.nextOffset)buffered=undefined;
        }else result=await this.history.page(query,offset,signal,size);
      }
      if (disposed || current !== generation) return;
      if (followed) { currentPath = followed.nextPath; followQuery = followed.nextQuery; for (const item of followed.paths) historicalPaths.set(item.oid, item.path); }
      const graph = layoutGraph(result.commits, continuation); continuation = graph.continuation;
      commits.push(...result.commits); rows.push(...graph.rows); offset = result.nextOffset; limitReached = result.hasMore && commits.length >= 2000; hasMore = result.hasMore && !limitReached;
      lastScanned=followed?.scanned??0;pageLoaded=true;await postPage();
    };
    const receive = panel.webview.onDidReceiveMessage(async raw => {
      let current = generation, ownedDiff = false,ownedRequest=false;
      try {
        const action = parseHistoryAction(raw);
        if (disposed || action.session !== session) throw new Error('History session expired.');
        if (action.type === 'cancel') {
          if (diffBusy) throw new Error('Wait for the native diff to open; that action cannot be cancelled here.');
          if (!requestBusy && !initialAcquisition) return;
          current = ++generation;
          request?.abort(); request = undefined;
          initialController?.abort(); initialController = undefined; initialAcquisition = undefined;
          requestBusy = false; clearQuery();
          await post({ type: 'reset' });
          if (disposed || current !== generation) return;
          await post({ type: 'cancelled', message: 'Request cancelled. Git may still be stopping. Refresh to start a new query.' });
          if (disposed || current !== generation) return;
          await post({ type: 'busy', busy: false, canCancel: false });
          return;
        }
        if(action.type==='copy'){
          if(selected!==action.oid&&!commits.some(commit=>commit.oid===action.oid))throw new Error('Copy requires a loaded commit.');
          const content=action.field==='hash'?action.oid:await this.history.message(repositoryId,action.oid);
          if(!disposed&&current===generation)await vscode.env.clipboard.writeText(content);return;
        }
        if (action.type === 'diff'||action.type==='workingDiff') {
          if (diffBusy) throw new Error('Wait for the current diff to open.');
          const captured = comparison, file = captured?.files[action.index];
          if (!captured || !file) throw new Error('Select a current comparison file.');
          diffBusy = true; ownedDiff = true; await post({ type: 'busy', busy: true, canCancel: false });
          if(action.type==='workingDiff'){
            const workingPath=path&&historicalPaths.get(captured.to)===file.path?path:file.path;
            const [left,right]=await Promise.all([this.history.revision(repositoryId,captured.to,file.path),this.history.workingRevision(repositoryId,workingPath)]);
            if(disposed||captured!==comparison)return;
            await vscode.commands.executeCommand('vscode.diff',this.revisions.add(left,file.path),this.revisions.add(right,workingPath),`${file.path} (${captured.to.slice(0,8)} ↔ saved working file; unsaved edits excluded)`);return;
          }
          const [left, right] = await Promise.all([
            this.history.revision(repositoryId, captured.from, file.originalPath ?? file.path),
            this.history.revision(repositoryId, captured.to, file.path)
          ]);
          if (disposed || captured !== comparison) return;
          await vscode.commands.executeCommand('vscode.diff', this.revisions.add(left, file.originalPath ?? file.path), this.revisions.add(right, file.path), `${file.path} (${captured.from?.slice(0, 8) ?? 'Empty'} ↔ ${captured.to.slice(0, 8)})`); return;
        }
        request?.abort(); request = new AbortController(); const signal = request.signal; current = ++generation;
        if (action.type !== 'ready' || !initialAcquisition) {
          initialController?.abort(); initialController = undefined; initialAcquisition = undefined;
        }
        requestBusy=true;ownedRequest=true;
        await post({ type: 'busy', busy: true, canCancel: !diffBusy });
        if (disposed || current !== generation || signal.aborted) return;
        if(action.type==='ready'&&query){
          // The renderer is recreated when hidden; readiness is not a new query.
          if(pageLoaded)await postPage();else await page(signal,current);
          if(current!==generation||disposed)return;
          if(detailMessage)await post(detailMessage);
          else if(sidePages)await post({type:'comparison',result:sidePages,inputs:comparisonInputs});
          if(current!==generation||disposed)return;
          if(selected)await post({type:'selection',oid:selected});
        }else if (action.type === 'ready' || action.type === 'query') {
          const filters = action.type === 'query' ? action.filters : path ? { path, follow: true } : {};
          if (path && filters.path) filters.follow = true;
          clearQuery();
          queryRef = action.type === 'query' ? action.ref || 'HEAD' : initialRef;
          await post({ type: 'reset' });
          if (disposed || current !== generation || signal.aborted) return;
          const pending = action.type === 'ready' ? initialAcquisition : undefined;
          initialAcquisition = undefined;
          const acquired = pending ? await pending : undefined;
          if (disposed || current !== generation || signal.aborted) return;
          initialController = undefined;
          if (acquired && 'error' in acquired) throw acquired.error;
          const pinned = acquired?.query ?? await this.history.pin(repositoryId, action.type === 'query' ? action.ref || 'HEAD' : initialRef, filters, signal);
          if (current !== generation || disposed) return;
          buffered=undefined;query = pinned; offset = 0; hasMore = false; commits = []; rows = []; continuation = []; selected = undefined; comparison = undefined;
          queryRef=action.type==='query'?action.ref||'HEAD':initialRef;lastScanned=0;pageLoaded=false;limitReached=false;
          detailMessage=undefined;sidePages=undefined;comparisonInputs=undefined;comparisonCommits.clear();
          currentPath = pinned.filters.path; followQuery = undefined; historicalPaths.clear();
          await page(signal, current, acquired);
          if (disposed || current !== generation || signal.aborted) return;
          if(action.type==='ready'&&selectTip&&pinned.tips[0]){
            const details=await this.history.details(repositoryId,pinned.tips[0],0,signal);if(current!==generation||disposed)return;
            selected=details.commit.oid;comparison={...(details.parent?{from:details.parent}:{}),to:details.commit.oid,files:details.files};
            detailMessage={type:'details',details,parentIndex:0,historicalPath:historicalPaths.get(selected)};
            await post({type:'selection',oid:selected});await post(detailMessage);lookupRefs(selected);
          }
        } else if (action.type === 'more') {
          if (!hasMore) throw new Error('No further history page.'); await page(signal, current);
        } else if (action.type === 'select') {
          if (selected!==action.oid&&!commits.some(commit => commit.oid === action.oid)&&!comparisonCommits.has(action.oid)) throw new Error('Select a loaded commit.');
          const details = await this.history.details(repositoryId, action.oid, action.parent, signal);
          if (current !== generation || disposed) return;
          selected = action.oid; comparison = { ...(details.parent ? { from: details.parent } : {}), to: action.oid, files: details.files };
          sidePages=undefined;comparisonInputs=undefined;comparisonCommits.clear();
          detailMessage={ type: 'details', details, parentIndex: action.parent, historicalPath: historicalPaths.get(action.oid) };await post(detailMessage);lookupRefs(action.oid);
        } else if (action.type === 'compare') {
          const result = await this.history.compare(repositoryId, action.from, action.to, signal);
          if (current !== generation || disposed) return;
          refsLookup?.abort();refsLookup=undefined;selected = undefined;detailMessage=undefined; comparison = result;sidePages=result;comparisonInputs={from:action.from,to:action.to};updateSideMembership();await post({ type: 'comparison', result,inputs:comparisonInputs });
        }else if(action.type==='comparePage'){
          const captured=sidePages;if(!captured)throw new Error('Comparison pages expired. Compare again.');
          const offset=action.side==='left'?captured.leftOffset:captured.rightOffset,count=action.side==='left'?captured.leftCount:captured.rightCount;
          if(Math.abs(action.offset-offset)!==25||action.offset>=count)throw new Error('Choose an adjacent comparison page.');
          const page=await this.history.comparisonPage(repositoryId,action.side==='left'?captured.from:captured.to,action.side==='left'?captured.to:captured.from,action.offset,signal);
          if(current!==generation||disposed||sidePages!==captured)return;
          sidePages={...captured,...(action.side==='left'?{leftOffset:action.offset,leftCommits:page}:{rightOffset:action.offset,rightCommits:page})};comparison=sidePages;updateSideMembership();await post({type:'comparison',result:sidePages,inputs:comparisonInputs});
        }
      } catch (error) { if (!disposed && current === generation) await post({ type: 'error', message: redact(String(error)) }); }
      finally { if (ownedDiff) diffBusy = false;if(ownedRequest&&current===generation)requestBusy=false; if (!disposed && !requestBusy&&!diffBusy&&(ownedDiff||ownedRequest)&&(ownedDiff||current===generation)) await post({ type: 'busy', busy: false, canCancel: false, selected }); }
    });
    const dispose = panel.onDidDispose(() => { disposed = true; generation++; request?.abort();refsLookup?.abort();initialController?.abort();initialController=undefined;initialAcquisition=undefined;buffered=undefined; receive.dispose(); dispose.dispose(); this.panels.delete(panel); commits = []; rows = []; comparison = undefined;detailMessage=undefined;sidePages=undefined;comparisonInputs=undefined;comparisonCommits.clear();historicalPaths.clear();followQuery=undefined;query=undefined; });
    if (!path) {
      initialController = new AbortController();
      const signal = initialController.signal;
      initialAcquisition = (async (): Promise<InitialPage> => {
        const size = pageSize();
        const query = await this.history.pin(repositoryId, initialRef, {}, signal);
        const first = await this.history.page(query, 0, signal, size);
        return { query, page: first, size };
      })().catch((error: unknown) => ({ error }));
    }
    panel.webview.html = historyHtml({session,nonce,cspSource:panel.webview.cspSource,resource});
  }
  dispose(): void { for (const panel of this.panels) panel.dispose(); this.panels.clear(); }
}
