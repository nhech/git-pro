import * as vscode from 'vscode';
import * as path from 'node:path';
import { stat } from 'node:fs/promises';
import type { HistoryService } from '../git/history/history.service';
import type { RepositoryRegistry } from '../repositories/repository-registry';
import type { parseBlame } from '../git/history/blame-parser';
import { canonicalFilePath } from '../security/paths';
type Blame = Pick<ReturnType<typeof parseBlame>,'oid'|'author'|'timestamp'|'summary'|'uncommitted'>;
/** Opt-in active-line reads; dirty buffers never receive an on-disk attribution. */
export class BlameController implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({ after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('editorCodeLens.foreground') } });
  private readonly subscriptions: vscode.Disposable[];
  private readonly cache = new Map<string, Blame>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private request: AbortController | undefined;
  private generation = 0; private disposed = false;
  /** Editors carrying an annotation, so a disabled controller still clears one that was hidden when blame was turned off. */
  private readonly decorated = new WeakSet<vscode.TextEditor>();
  private current:{repositoryId:string;oid:string;editor:vscode.TextEditor;line:number}|undefined;
  constructor(private readonly history: HistoryService, private readonly registry: RepositoryRegistry,private readonly openCommit?:(id:string,oid:string)=>void) {
    this.subscriptions = [vscode.window.onDidChangeTextEditorSelection(() => this.schedule()), vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument(() => this.schedule()), vscode.workspace.onDidSaveTextDocument(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('gitPro.blame')) this.schedule(); }),
      registry.onDidChange(() => { this.cache.clear(); this.schedule(); })];
    this.schedule();
  }
  private schedule(): void {
    if (this.disposed) return;
    this.generation++;this.current=undefined; this.request?.abort(); if (this.timer) clearTimeout(this.timer);
    const configuration=vscode.workspace.getConfiguration('gitPro',vscode.window.activeTextEditor?.document.uri);
    const enabled=configuration.get('blame.enabled', false);
    // While blame is off this runs on every keystroke and cursor move, so only touch editors that still carry an annotation.
    for (const editor of vscode.window.visibleTextEditors) if (enabled||this.decorated.has(editor)) { editor.setDecorations(this.decoration, []); this.decorated.delete(editor); }
    if (!enabled) return;
    const configured=configuration.get<number>('blame.delay',250);
    const delay=Number.isFinite(configured)?Math.max(100,Math.min(2000,Math.round(configured))):250;
    const current = this.generation; this.timer = setTimeout(() => { this.timer = undefined; void this.show(current); }, delay);
  }
  private async show(generation: number): Promise<void> {
    const editor = vscode.window.activeTextEditor; if (!editor || editor.document.uri.scheme !== 'file' || editor.document.isDirty) return;
    const request = new AbortController(); this.request = request;
    try {
      const repo = await this.registry.resolveFile(editor.document.uri.fsPath); if (!repo) return;
      const relative = path.relative(repo.root, await canonicalFilePath(editor.document.uri.fsPath)).replace(/\\/g, '/'), line = editor.selection.active.line;
      const info = await stat(editor.document.uri.fsPath), head = this.registry.store.get(repo.id)?.oid ?? '';
      const key = `${repo.id}\0${head}\0${relative}\0${info.mtimeMs}\0${info.size}\0${line}`;
      let blame=this.cache.get(key);
      if(!blame){const parsed=await this.history.blame(repo.id,relative,line+1,request.signal);const bound=(text:string,limit:number)=>text.length>limit?text.slice(0,limit)+'…':text;blame={oid:parsed.oid,author:bound(parsed.author,500),timestamp:parsed.timestamp,summary:bound(parsed.summary,2000),uncommitted:parsed.uncommitted};}
      if (this.disposed || generation !== this.generation || editor !== vscode.window.activeTextEditor || editor.document.isDirty || editor.selection.active.line !== line) return;
      if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value!); this.cache.set(key, blame);
      const hover = new vscode.MarkdownString(); hover.isTrusted = false; hover.supportHtml = false;
      const date = new Date(blame.timestamp * 1000);
      const dateLabel = Number.isFinite(date.getTime()) ? `${date.toISOString()} (UTC)` : 'Date unavailable';
      hover.appendText(blame.uncommitted ? 'Uncommitted changes' : `${blame.author}\n${dateLabel}\n${blame.oid}\n${blame.summary}`);
      if(!blame.uncommitted&&this.openCommit){this.current={repositoryId:repo.id,oid:blame.oid,editor,line};hover.isTrusted={enabledCommands:['gitPro.openBlameCommit']};hover.appendMarkdown('\n\n[Open commit details](command:gitPro.openBlameCommit)');}
      this.decorated.add(editor);
      editor.setDecorations(this.decoration, [{ range: editor.document.lineAt(line).range, hoverMessage: hover,
        renderOptions: { after: { contentText: blame.uncommitted ? 'Uncommitted changes' : `${blame.author.replace(/[\r\n\t]/g, ' ').slice(0, 60)} • ${blame.summary.replace(/[\r\n\t]/g, ' ').slice(0, 100)}` } } }]);
    } catch { /* Attribution is optional; cancelled, binary and unavailable files stay quiet. */ }
  }
  openCurrentCommit():void{
    const current=this.current;if(!current||this.disposed||current.editor!==vscode.window.activeTextEditor||current.editor.document.isDirty||current.editor.selection.active.line!==current.line)throw new Error('Enable blame and select a saved committed line first.');
    this.openCommit?.(current.repositoryId,current.oid);
  }
  dispose(): void { this.disposed = true; this.generation++; if (this.timer) clearTimeout(this.timer); this.request?.abort(); for (const item of this.subscriptions) item.dispose(); this.decoration.dispose(); this.cache.clear(); }
}
