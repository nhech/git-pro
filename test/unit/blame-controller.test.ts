import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';

for (const { timestamp, dateLabel, label } of [
  { timestamp: 1791072000, dateLabel: '2026-10-04T00:00:00.000Z (UTC)', label: 'UTC date' },
  { timestamp: -1, dateLabel: '1969-12-31T23:59:59.000Z (UTC)', label: 'pre-epoch date' },
  { timestamp: Number.MAX_SAFE_INTEGER, dateLabel: 'Date unavailable', label: 'out-of-range date' },
]) test(`blame link preserves safe metadata and rejects expired attribution: ${label}`,async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'git-pro-blame-unit-'));
  try{
    const file=path.join(root,'line.txt');await writeFile(file,'committed\n');
    const events=new Map<string,()=>void>();let timer:(()=>void)|undefined;
    const decorations:{hoverMessage?:{isTrusted:unknown;text:string[];markdown:string[]}}[]=[];
    let decorationReady:()=>void=()=>undefined;const rendered=new Promise<void>(resolve=>{decorationReady=resolve;});
    const editor={document:{uri:{scheme:'file',fsPath:file},isDirty:false,lineAt:()=>({range:{}})},selection:{active:{line:0}},setDecorations:(_type:unknown,items:typeof decorations)=>{decorations.splice(0,decorations.length,...items);if(items[0]?.hoverMessage)decorationReady();}};
    const subscribe=(name:string)=>(callback:()=>void)=>{events.set(name,callback);return{dispose:()=>events.delete(name)};};
    class MarkdownString {isTrusted:unknown;supportHtml=false;text:string[]=[];markdown:string[]=[];appendText(value:string){this.text.push(value);}appendMarkdown(value:string){this.markdown.push(value);}}
    const vscode={MarkdownString,ThemeColor:class{},window:{activeTextEditor:editor,visibleTextEditors:[editor],createTextEditorDecorationType:()=>({dispose:()=>undefined}),onDidChangeTextEditorSelection:subscribe('selection'),onDidChangeActiveTextEditor:subscribe('active')},workspace:{getConfiguration:()=>({get:(key:string,fallback:unknown)=>key==='blame.enabled'?true:fallback}),onDidChangeTextDocument:subscribe('change'),onDidSaveTextDocument:subscribe('save'),onDidChangeConfiguration:subscribe('configuration')}};
    const exports:Record<string,unknown>={},load=createRequire(__filename);
    runInNewContext(readFileSync(path.resolve(__dirname,'../../src/editor/blame-controller.js'),'utf8'),{exports,require:(name:string)=>name==='vscode'?vscode:name==='../security/paths'?{canonicalFilePath:async(value:string)=>value}:load(name),setTimeout:(callback:()=>void)=>{timer=callback;return 1;},clearTimeout:()=>{timer=undefined;},AbortController});
    const oid='a'.repeat(40),opened:string[][]=[];
    const history={blame:async()=>({oid,author:'[attack](command:evil)',timestamp,summary:'<script>attack</script>',uncommitted:false,content:'large source line'.repeat(10000)})};
    const registry={resolveFile:async()=>({id:'owned',root}),store:{get:()=>({oid})},onDidChange:subscribe('registry')};
    const Controller=exports.BlameController as new(history:unknown,registry:unknown,open:(id:string,oid:string)=>void)=>{openCurrentCommit():void;dispose():void};
    const controller=new Controller(history,registry,(id,hash)=>opened.push([id,hash]));
    timer!();
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([rendered,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Blame attribution was not rendered.')),2000);})]);}finally{if(timeout)clearTimeout(timeout);}
    const hover=decorations[0]?.hoverMessage;assert.ok(hover);
    const retained=(controller as unknown as {cache:Map<string,Record<string,unknown>>}).cache.values().next().value!;assert.equal(Object.hasOwn(retained,'content'),false);assert.ok(Object.keys(retained).length<=5);assert.equal(retained.timestamp,timestamp);
    assert.deepEqual(Array.from((hover.isTrusted as {enabledCommands:string[]}).enabledCommands),['gitPro.openBlameCommit']);
    assert.match(hover.text.join(''),/command:evil/);assert.equal(hover.markdown.join(''),'\n\n[Open commit details](command:gitPro.openBlameCommit)');
    assert.ok(hover.text.join('').includes(dateLabel));
    controller.openCurrentCommit();assert.deepEqual(opened,[['owned',oid]]);
    editor.document.isDirty=true;assert.throws(()=>controller.openCurrentCommit(),/saved committed line/);
    editor.document.isDirty=false;events.get('selection')!();assert.throws(()=>controller.openCurrentCommit(),/saved committed line/);
    controller.dispose();assert.equal(events.size,0);assert.throws(()=>controller.openCurrentCommit(),/saved committed line/);assert.equal(opened.length,1);
  }finally{assert.ok(root.startsWith(path.join(tmpdir(),'git-pro-blame-unit-')));await rm(root,{recursive:true,force:true});}
});
