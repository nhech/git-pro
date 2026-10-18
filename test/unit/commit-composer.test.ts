import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import * as path from 'node:path';

const plain=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
test('composer busy focus returns after failure, success or repo switch without stealing focus',()=>{
  let receive:((event:{data:unknown})=>void)|undefined,focused=true;
  class Control{
    value='';textContent='';title='';checked=false;isConnected=true;dataset:Record<string,string>={};attributes=new Map<string,string>();children:unknown[]=[];handlers=new Map<string,()=>void>();private inactive=false;
    get disabled(){return this.inactive;}set disabled(value:boolean){this.inactive=value;if(value&&document.activeElement===this)document.activeElement=body;}
    focus(){document.activeElement=this;}setAttribute(key:string,value:string){this.attributes.set(key,value);}addEventListener(type:string,callback:()=>void){this.handlers.set(type,callback);}dispatchEvent(event:{type:string}){this.handlers.get(event.type)?.();}replaceChildren(...children:unknown[]){this.children=children;}
  }
  const body=new Control(),elements=new Map(['repository','staged','message','warning','amend','signoff','noVerify','commit','commit-label','advanced-label','push','history','clearHistory','result'].map(id=>[id,new Control()]));body.dataset.session='s';
  const document={body,activeElement:body,hasFocus:()=>focused,getElementById:(id:string)=>elements.get(id)};
  runInNewContext(readFileSync('media/commit.js','utf8'),{document,window:{addEventListener:(_type:string,callback:typeof receive)=>{receive=callback;}},acquireVsCodeApi:()=>({postMessage:()=>undefined}),Option:class{},Event:class{constructor(readonly type:string){}}});
  const state=(repositoryId='repo',message='Draft',busy=false,staged=1,repository=repositoryId)=>receive!({data:{type:'state',session:'s',repositoryId,repository,message,busy,staged,operation:'idle',subjectLimit:72,history:[]}});
  const commit=elements.get('commit')!,message=elements.get('message')!;state();commit.focus();commit.dispatchEvent({type:'click'});assert.equal(document.activeElement,body);state('repo','Draft',true);state('repo','Draft',true);
  receive!({data:{type:'error',session:'expired',message:'Wrong'}});assert.equal(commit.disabled,true);receive!({data:{type:'error',session:'s',message:'Signing failed'}});assert.equal(document.activeElement,commit,'Failure restores the origin control while the draft remains available.');assert.equal(message.value,'Draft');assert.equal(body.attributes.get('aria-busy'),'false');
  assert.equal(elements.get('result')!.textContent,'Signing failed','Keep the failed-attempt feedback until an eligible explicit retry.');
  commit.dispatchEvent({type:'click'});assert.equal(elements.get('result')!.textContent,'','An eligible retry clears its previous error before entering busy state.');state('repo','',false,0);assert.equal(document.activeElement,message,'Successful commit returns to the editable message rather than a disabled Commit button.');assert.equal(elements.get('result')!.textContent,'','Successful completion cannot retain the failed-attempt feedback.');
  receive!({data:{type:'error',session:'s',message:'Keep disabled-attempt feedback'}});commit.dispatchEvent({type:'click'});assert.equal(elements.get('result')!.textContent,'Keep disabled-attempt feedback','Disabled clicks do not clear feedback or begin a retry.');
  document.activeElement=body;state();commit.focus();assert.equal(commit.disabled,false);commit.dispatchEvent({type:'click'});state('different','Other draft');assert.equal(document.activeElement,message,'Repository changes do not reuse the previous repository action focus.');assert.equal(message.value,'Other draft');
  document.activeElement=body;state();commit.focus();commit.dispatchEvent({type:'click'});const outside=new Control();outside.focus();state();assert.equal(document.activeElement,outside,'Do not steal deliberately moved focus.');
  commit.focus();commit.dispatchEvent({type:'click'});focused=false;state();assert.equal(document.activeElement,body);focused=true;state();assert.equal(document.activeElement,body,'Inactive completion releases its captured reference.');
  state('first','Draft',false,1,'C:\\one\\same <name>');
  assert.equal(elements.get('repository')!.textContent,'same <name>');assert.equal(elements.get('repository')!.attributes.get('aria-label'),'C:\\one\\same <name>');assert.equal(elements.get('repository')!.title,'C:\\one\\same <name>');
  const skip=elements.get('noVerify')!;skip.checked=true;skip.dispatchEvent({type:'change'});assert.equal(elements.get('advanced-label')!.textContent,'Advanced options · Skip hooks');
  state('first','Draft',false,1,'C:\\one\\same <name>');assert.equal(elements.get('advanced-label')!.textContent,'Advanced options · Skip hooks','Ordinary refresh keeps selected hook opt-out apparent.');
  commit.focus();commit.dispatchEvent({type:'click'});assert.equal(elements.get('commit-label')!.textContent,'Committing…');receive!({data:{type:'error',session:'s',message:'Failed'}});assert.equal(elements.get('commit-label')!.textContent,'Commit');assert.equal(elements.get('advanced-label')!.textContent,'Advanced options · Skip hooks');
  state('second','',false,0,'/two/same <name>');assert.equal(elements.get('repository')!.textContent,'same <name>');assert.equal(elements.get('repository')!.attributes.get('aria-label'),'/two/same <name>');assert.equal(skip.checked,false);assert.equal(elements.get('advanced-label')!.textContent,'Advanced options');assert.equal(commit.disabled,true);assert.equal(elements.get('push')!.disabled,true);assert.equal(elements.get('staged')!.attributes.get('data-ready'),'false');
});

test('composer signing failure shows safe recovery, preserves draft/history and rejects expired sessions',async()=>{
  const file=path.resolve(__dirname,'../../src/webviews/commit/commit-composer.js'),load=createRequire(file),exports:Record<string,unknown>={};
  const disposable={dispose:()=>undefined},messages:Record<string,unknown>[]=[],state=new Map<string,unknown>([['gitPro.messages:repo',['earlier message']]]);let receive:(value:unknown)=>Promise<void>=async()=>undefined,calls=0;
  const vscode={workspace:{onDidChangeConfiguration:()=>disposable,getConfiguration:()=>({get:()=>undefined})},Uri:{file:(value:string)=>value,joinPath:(_root:unknown,...parts:string[])=>parts.join('/')}};
  runInNewContext(readFileSync(file,'utf8'),{exports,require:(name:string)=>name==='vscode'?vscode:load(name)});
  const context={extensionUri:'owned',workspaceState:{get:(key:string,fallback:unknown)=>state.get(key)??fallback,update:async(key:string,value:unknown)=>{state.set(key,value);}}};
  const git={registry:{active:{id:'repo',root:'fixture'},onDidChange:()=>disposable,store:new Map([['repo',{changes:[{group:'staged'}],operation:'idle',head:'main'}]])},repository:()=>({root:'fixture'})};
  type Composer={resolveWebviewView(view:unknown):Promise<void>;dispose():void};
  const Constructor=exports.CommitComposer as new(context:unknown,git:unknown,commit:()=>Promise<boolean>,logger:{info(message:string):void;error(message:string):void})=>Composer;
  const diagnostics:string[]=[];
  const composer=new Constructor(context,git,async()=>{calls++;throw Object.assign(new Error('Signing failed'),{stderr:'gpg failed to sign the data\npassword=PRIVATE_SENTINEL'});},{info:()=>undefined,error:message=>{diagnostics.push(message);}});
  const view={webview:{html:'',asWebviewUri:String,cspSource:'owned:',onDidReceiveMessage:(callback:typeof receive)=>{receive=callback;return disposable;},postMessage:async(value:Record<string,unknown>)=>{messages.push(value);return true;}},onDidDispose:()=>disposable};
  try{
    await composer.resolveWebviewView(view);const session=/data-session="([^"]+)"/.exec(view.webview.html)![1]!;
    const request={type:'commit',session,repositoryId:'repo',message:'keep this draft',amend:false,signoff:false,noVerify:false,push:false};
    await receive(request);assert.equal(calls,1);assert.equal(state.get('gitPro.draft:repo'),'keep this draft');assert.deepEqual(state.get('gitPro.messages:repo'),['earlier message']);
    const error=messages.find(message=>message.type==='error')!;assert.match(String(error.message),/will not disable signing/);assert.equal(String(error.message).includes('PRIVATE_SENTINEL'),false);
    assert.match(String(error.message),/^Commit signing failed\./);assert.equal(String(error.message).includes('gpg failed'),false);
    assert.match(diagnostics[0]!,/gpg failed to sign/);assert.equal(diagnostics[0]!.includes('PRIVATE_SENTINEL'),false);
    assert.equal(messages.filter(message=>message.type==='state').at(-1)!.busy,false);assert.equal(messages.filter(message=>message.type==='state').at(-1)!.branch,'main','The state names the branch for the placeholder.');
    await receive({...request,session:'expired'});assert.equal(calls,1);assert.equal(state.get('gitPro.draft:repo'),'keep this draft');
  }finally{composer.dispose();}
});

test('Ctrl+Enter in the message box commits like the Commit button, and only when it is enabled',()=>{
  let receive:((event:{data:unknown})=>void)|undefined;const posted:Record<string,unknown>[]=[];
  class Control{
    value='';textContent='';title='';placeholder='';checked=false;disabled=false;isConnected=true;dataset:Record<string,string>={};attributes=new Map<string,string>();handlers=new Map<string,(event:Record<string,unknown>)=>void>();
    focus(){document.activeElement=this;}setAttribute(key:string,value:string){this.attributes.set(key,value);}addEventListener(type:string,callback:(event:Record<string,unknown>)=>void){this.handlers.set(type,callback);}
    dispatchEvent(event:{type:string}){this.handlers.get(event.type)?.(event as never);}click(){this.handlers.get('click')?.({});}replaceChildren(){}
  }
  const body=new Control(),elements=new Map(['repository','staged','message','warning','amend','signoff','noVerify','commit','commit-label','advanced-label','push','history','clearHistory','result'].map(id=>[id,new Control()]));body.dataset.session='s';
  const document={body,activeElement:body as Control,hasFocus:()=>true,getElementById:(id:string)=>elements.get(id)};
  runInNewContext(readFileSync('media/commit.js','utf8'),{document,window:{addEventListener:(_type:string,callback:typeof receive)=>{receive=callback;}},navigator:{platform:'Win32'},acquireVsCodeApi:()=>({postMessage:(value:Record<string,unknown>)=>posted.push(value)}),Option:class{},Event:class{constructor(readonly type:string){}}});
  const message=elements.get('message')!,press=(extra:Record<string,unknown>)=>{let prevented=false;message.handlers.get('keydown')!({key:'Enter',ctrlKey:false,metaKey:false,shiftKey:false,altKey:false,...extra,preventDefault:()=>{prevented=true;}});return prevented;};
  receive!({data:{type:'state',session:'s',repositoryId:'repo',repository:'repo',message:'',busy:false,staged:1,operation:'idle',subjectLimit:72,history:[]}});
  receive!({data:{type:'state',session:'s',repositoryId:'repo',repository:'repo',message:'',busy:false,staged:1,operation:'idle',subjectLimit:72,history:[],branch:'main'}});assert.equal(message.placeholder,"Message (Ctrl+Enter to commit on 'main')");
  receive!({data:{type:'state',session:'s',repositoryId:'repo',repository:'repo',message:'',busy:false,staged:1,operation:'idle',subjectLimit:72,history:[],branch:''}});assert.equal(message.placeholder,'Message (Ctrl+Enter to commit)');
  assert.equal(press({ctrlKey:true}),true);assert.equal(posted.filter(item=>item.type==='commit').length,0,'an empty message keeps Commit disabled');
  message.value='Greet loudly';message.handlers.get('input')!({});
  assert.equal(press({}),false,'a plain Enter adds a new line');assert.equal(press({ctrlKey:true,shiftKey:true}),false);
  press({ctrlKey:true});const sent=posted.filter(item=>item.type==='commit');assert.equal(sent.length,1);assert.equal(sent[0]!.push,false);assert.equal(sent[0]!.message,'Greet loudly');
  // During an operation the composer points to Git Pro's own Conflicts tab, not to Source Control.
  receive!({data:{type:'state',session:'s',repositoryId:'repo',repository:'repo',message:'',busy:false,staged:1,operation:'merging',subjectLimit:72,history:[]}});
  assert.equal(elements.get('staged')!.textContent,'merging in progress · resolve in Git Pro Conflicts');assert.equal(elements.get('commit')!.disabled,true);
});

test('a Conventional Commit choice from the host rewrites only the prefix of the first line, for the types the setting lists',()=>{
  let receive:((event:{data:unknown})=>void)|undefined;const posted:Record<string,unknown>[]=[];
  class Control{
    value='';textContent='';title='';placeholder='';checked=false;disabled=false;hidden=false;open=false;isConnected=true;selection:number[]=[];dataset:Record<string,string>={};attributes=new Map<string,string>();handlers=new Map<string,((event:Record<string,unknown>)=>void)[]>();
    focus(){document.activeElement=this;}setAttribute(key:string,value:string){this.attributes.set(key,value);}addEventListener(type:string,callback:(event:Record<string,unknown>)=>void){this.handlers.set(type,[...(this.handlers.get(type)??[]),callback]);}
    fire(type:string){for(const callback of this.handlers.get(type)??[])callback({type});}dispatchEvent(event:{type:string}){this.fire(event.type);}click(){this.fire('click');}replaceChildren(){}querySelector(){return undefined;}contains(){return false;}
    setSelectionRange(start:number,end:number){this.selection=[start,end];}
  }
  const ids=['repository','staged','message','warning','amend','signoff','noVerify','commit','commit-label','advanced-label','push','history','clearHistory','result','commit-menu'];
  const body=new Control(),elements=new Map(ids.map(id=>[id,new Control()]));body.dataset.session='s';
  const document={body,activeElement:body as Control,hasFocus:()=>true,addEventListener:()=>undefined,getElementById:(id:string)=>elements.get(id)};
  runInNewContext(readFileSync('media/commit.js','utf8'),{document,window:{addEventListener:(type:string,callback:typeof receive)=>{if(type==='message')receive=callback;}},navigator:{platform:'Win32'},acquireVsCodeApi:()=>({postMessage:(value:Record<string,unknown>)=>posted.push(value)}),Option:class{constructor(readonly text:string,readonly value:string){}},Event:class{constructor(readonly type:string){}}});
  const message=elements.get('message')!;
  // The message box that was just written to has the focus, and a refresh does not take a message from under the cursor: the tests look away first.
  const state=(extra:Record<string,unknown>={})=>{document.activeElement=body;receive!({data:{type:'state',session:'s',repositoryId:'repo',repository:'repo',message:'',busy:false,staged:1,operation:'idle',subjectLimit:72,history:[],conventionalTypes:['feat','fix','docs','my-type'],...extra}});};
  const choose=(type:string,scope='',breaking=false,extra:Record<string,unknown>={})=>receive!({data:{type:'conventional',session:'s',repositoryId:'repo',value:{type,scope,breaking},...extra}});
  const typed=(value:string)=>{message.value=value;message.fire('input');};
  const drafts=()=>posted.filter(item=>item.type==='draft').map(item=>item.message);
  state();

  typed('add parser');choose('feat');
  assert.equal(message.value,'feat: add parser');assert.equal(drafts().at(-1),'feat: add parser','the draft follows the rewrite');assert.equal(document.activeElement,message,'and the message is where the next keystroke goes');assert.deepEqual(message.selection,[16,16],'at the end of the first line');
  choose('feat','api');assert.equal(message.value,'feat(api): add parser','a type that is already there is replaced, not added to');
  choose('feat','api',true);assert.equal(message.value,'feat(api)!: add parser');
  choose('feat',' (a)(b)\n ');assert.equal(message.value,'feat(ab): add parser','brackets and line breaks cannot end up in the scope');
  choose('feat','x'.repeat(60));assert.equal(message.value,`feat(${'x'.repeat(40)}): add parser`,'a scope is at most 40 characters');
  choose('fix','',false);assert.equal(message.value,'fix: add parser');

  // Only the first line changes; the body is kept as it is.
  typed('feat(api)!: add parser\n\nBody text\nsecond: line');choose('fix','core');assert.equal(message.value,'fix(core): add parser\n\nBody text\nsecond: line');assert.deepEqual(message.selection,['fix(core): add parser'.length,'fix(core): add parser'.length]);
  choose('');assert.equal(message.value,'add parser\n\nBody text\nsecond: line','no type removes the prefix');choose('');assert.equal(message.value,'add parser\n\nBody text\nsecond: line','and there is nothing more to remove');

  // A prefix that is not one of the listed types is part of the subject, not a type.
  typed('note: keep this');choose('fix');assert.equal(message.value,'fix: note: keep this');
  typed('Feat: capital');choose('docs');assert.equal(message.value,'docs: Feat: capital');typed('feat (x): y');choose('docs');assert.equal(message.value,'docs: feat (x): y','a space before the scope is not a prefix');
  typed('my-type(x): y');choose('fix','z');assert.equal(message.value,'fix(z): y');typed('feat:no space');choose('docs');assert.equal(message.value,'docs: no space');
  typed('');choose('docs');assert.equal(message.value,'docs: ','an empty message gets just the prefix');

  // What the host cannot ask for: a type that is not listed, a type that is not text, another repository or session, a message without a value, a commit in progress, no repository.
  typed('keep');const before=posted.length;
  choose('nope');choose('Feat');choose('feat; rm -rf');receive!({data:{type:'conventional',session:'s',repositoryId:'repo',value:{type:5,scope:'',breaking:false}}});receive!({data:{type:'conventional',session:'s',repositoryId:'repo'}});receive!({data:{type:'conventional',session:'s',repositoryId:'repo',value:null}});
  choose('feat','',false,{repositoryId:'elsewhere'});choose('feat','',false,{session:'expired'});
  assert.equal(message.value,'keep');assert.equal(posted.length,before,'nothing was written, so nothing was posted');
  choose('feat','',7 as unknown as boolean);assert.equal(message.value,'feat: keep','only true is a breaking change');
  state({busy:true,message:'keep'});choose('fix');assert.equal(message.value,'keep');
  state({repositoryId:'',repository:'Choose a repository'});choose('fix','',false,{repositoryId:''});assert.equal(message.value,'');
  // The types the setting holds, as the view reads them: lower-case words only, none when the list is not one.
  state({message:'add'});choose('feat');assert.equal(message.value,'feat: add');
  state({conventionalTypes:['Feat','x'.repeat(30),5,null,'ok-1'],message:'add'});choose('feat');assert.equal(message.value,'add','feat is no longer a type');choose('ok-1');assert.equal(message.value,'ok-1: add');
  state({conventionalTypes:undefined,message:'add'});choose('ok-1');assert.equal(message.value,'add');state({conventionalTypes:'feat',message:'add'});choose('feat');assert.equal(message.value,'add');
});

/** The composer host over stand-ins, for the Quick Picks of Conventional Commit… */
function conventionalHarness(options:{types?:unknown;visible?:boolean;active?:boolean}={}){
  const file=path.resolve(__dirname,'../../src/webviews/commit/commit-composer.js'),load=createRequire(file),exports:Record<string,unknown>={};
  const disposable={dispose:()=>undefined},messages:Record<string,unknown>[]=[],executed:string[]=[],picks:{title:string;items:{label:string;description?:string;value:unknown}[]}[]=[],inputs:{title:string;validateInput?:(value:string)=>string|undefined}[]=[];
  const answers={type:((items:{value:unknown}[])=>items.find(item=>item.value==='feat')) as (items:{value:unknown}[])=>unknown,scope:'api' as string|undefined,breaking:((items:{value:unknown}[])=>items.find(item=>item.value===false)) as (items:{value:unknown}[])=>unknown};
  let view:{visible:boolean;webview:Record<string,unknown>;onDidDispose:()=>unknown}|undefined,active:{id:string;root:string}|undefined=options.active===false?undefined:{id:'repo',root:'fixture'};
  const vscode={workspace:{onDidChangeConfiguration:()=>disposable,getConfiguration:()=>({get:(key:string)=>key==='commit.conventionalTypes'?('types' in options?options.types:['feat','fix','my-type']):undefined})},Uri:{file:(value:string)=>value,joinPath:(_root:unknown,...parts:string[])=>parts.join('/')},
    commands:{executeCommand:async(id:string)=>{executed.push(id);if(view)view.visible=true;}},
    window:{showQuickPick:async(items:{label:string;description?:string;value:unknown}[],pickOptions:{title:string})=>{picks.push({title:pickOptions.title,items:Array.from(items)});return pickOptions.title.endsWith(': type')?answers.type(items):answers.breaking(items);},
      showInputBox:async(inputOptions:{title:string;validateInput?:(value:string)=>string|undefined})=>{inputs.push(inputOptions);return answers.scope;}}};
  runInNewContext(readFileSync(file,'utf8'),{exports,setTimeout:(callback:()=>void)=>{callback();return 0;},require:(name:string)=>name==='vscode'?vscode:load(name)});
  const context={extensionUri:'owned',workspaceState:{get:(_key:string,fallback:unknown)=>fallback,update:async()=>undefined}};
  const git={registry:{get active(){return active;},onDidChange:()=>disposable,store:new Map([['repo',{changes:[],operation:'idle',head:'main'}]])},repository:()=>({root:'fixture'})};
  type Composer={resolveWebviewView(view:unknown):Promise<void>;chooseConventional():Promise<void>;dispose():void};
  const composer=new (exports.CommitComposer as new(context:unknown,git:unknown,commit:()=>Promise<boolean>)=>Composer)(context,git,async()=>true);
  return {composer,messages,executed,picks,inputs,answers,setActive:(value:typeof active)=>{active=value;},
    async show(){view={visible:options.visible!==false,webview:{html:'',asWebviewUri:String,cspSource:'owned:',onDidReceiveMessage:()=>disposable,postMessage:async(value:Record<string,unknown>)=>{messages.push(value);return true;}},onDidDispose:()=>disposable};await composer.resolveWebviewView(view);messages.length=0;return view;},
    hide(){if(view)view.visible=false;},dropView(){view=undefined;}};
}

test('Conventional Commit… asks for a type, a scope and a breaking mark in Quick Picks, then has the Commit view write them',async()=>{
  const h=conventionalHarness();await h.show();
  try{
    await h.composer.chooseConventional();
    assert.deepEqual(h.picks.map(pick=>pick.title),['Conventional Commit: type','Conventional Commit: breaking change?']);
    assert.deepEqual(h.picks[0]!.items.map(item=>[item.label,item.description,item.value]),[['$(close) No type','Remove the type from the first line',''],['feat','a new feature','feat'],['fix','a bug fix','fix'],['my-type','','my-type']],'the types of the setting, with what the usual ones mean');
    assert.deepEqual(h.picks[1]!.items.map(item=>[item.label,item.description,item.value]),[['No','feat(api): …',false],['Yes, a breaking change','feat(api)!: …',true]]);
    assert.equal(h.inputs[0]!.title,'Conventional Commit: scope');assert.equal(h.inputs[0]!.validateInput!('api'),undefined);assert.equal(h.inputs[0]!.validateInput!(''),undefined);for(const bad of ['a(b','a)','(a)','a\nb'])assert.equal(h.inputs[0]!.validateInput!(bad),'A scope has no brackets.',JSON.stringify(bad));
    // The view's state goes first, so it knows the types, and then the choice, for the session and repository of the view.
    assert.deepEqual(h.messages.map(message=>message.type),['state','conventional']);assert.deepEqual(plain(h.messages[1]!.value),{type:'feat',scope:'api',breaking:false});assert.equal(h.messages[1]!.repositoryId,'repo');assert.equal(typeof h.messages[1]!.session,'string');
    assert.deepEqual(plain(h.messages[0]!.conventionalTypes),['feat','fix','my-type']);
    // Breaking, and no scope; "no type" asks nothing more.
    h.messages.length=0;h.answers.scope='';h.answers.breaking=items=>items.find(item=>item.value===true);await h.composer.chooseConventional();assert.deepEqual(plain(h.messages.at(-1)!.value),{type:'feat',scope:'',breaking:true});assert.equal(h.picks.at(-1)!.items[0]!.description,'feat: …');assert.equal(h.picks.at(-1)!.items[1]!.description,'feat!: …');
    h.messages.length=0;const asked={picks:h.picks.length,inputs:h.inputs.length};h.answers.type=items=>items.find(item=>item.value==='');await h.composer.chooseConventional();assert.deepEqual(plain(h.messages.at(-1)!.value),{type:'',scope:'',breaking:false});assert.equal(h.picks.length,asked.picks+1);assert.equal(h.inputs.length,asked.inputs,'no scope is asked for when there is no type');
  }finally{h.composer.dispose();}
});

test('Conventional Commit… stops where the user stops, and says what is missing',async()=>{
  // Cancelling any question writes nothing.
  const cancelType=conventionalHarness();await cancelType.show();cancelType.answers.type=()=>undefined;await cancelType.composer.chooseConventional();assert.deepEqual(cancelType.messages,[]);assert.equal(cancelType.inputs.length,0);cancelType.composer.dispose();
  const cancelScope=conventionalHarness();await cancelScope.show();cancelScope.answers.scope=undefined;await cancelScope.composer.chooseConventional();assert.deepEqual(cancelScope.messages,[]);assert.equal(cancelScope.picks.length,1);cancelScope.composer.dispose();
  const cancelBreaking=conventionalHarness();await cancelBreaking.show();cancelBreaking.answers.breaking=()=>undefined;await cancelBreaking.composer.chooseConventional();assert.deepEqual(cancelBreaking.messages,[]);cancelBreaking.composer.dispose();
  // No repository, no types, and a repository that changed while the questions were open.
  const none=conventionalHarness({active:false});await none.show();await assert.rejects(none.composer.chooseConventional(),/Select a repository first/);none.composer.dispose();
  for(const types of [[],undefined,'feat',['Feat',5]]){const empty=conventionalHarness({types});await empty.show();await assert.rejects(empty.composer.chooseConventional(),/No commit types are listed in gitPro\.commit\.conventionalTypes/);assert.equal(empty.picks.length,0);empty.composer.dispose();}
  const moved=conventionalHarness();await moved.show();moved.answers.scope=undefined as unknown as string;moved.answers.type=items=>{moved.setActive({id:'other',root:'elsewhere'});return items.find(item=>item.value==='feat');};moved.answers.scope='api';
  await assert.rejects(moved.composer.chooseConventional(),/Repository changed/);assert.deepEqual(moved.messages,[]);moved.composer.dispose();
  // A Commit view that is hidden is shown first, and the choice waits for it; one that never comes is an error, not a lost choice.
  const hidden=conventionalHarness({visible:false});await hidden.show();await hidden.composer.chooseConventional();assert.deepEqual(hidden.executed,['gitPro.commitView.focus']);assert.deepEqual(hidden.messages.map(message=>message.type),['state','conventional']);hidden.composer.dispose();
  const absent=conventionalHarness();await absent.show();absent.dropView();(absent.composer as unknown as {view:undefined}).view=undefined;await assert.rejects(absent.composer.chooseConventional(),/Commit view is not available/);assert.deepEqual(absent.executed,['gitPro.commitView.focus']);absent.composer.dispose();
});

test('the composer sends the renderer only the commit types the setting holds that are valid, and none without a repository',async()=>{
  const file=path.resolve(__dirname,'../../src/webviews/commit/commit-composer.js'),load=createRequire(file),exports:Record<string,unknown>={};
  const disposable={dispose:()=>undefined},messages:Record<string,unknown>[]=[],state=new Map<string,unknown>();let active:{id:string;root:string}|undefined={id:'repo',root:'fixture'};
  const vscode={workspace:{onDidChangeConfiguration:()=>disposable,getConfiguration:()=>({get:(key:string)=>key==='commit.conventionalTypes'?['feat','Bad',5,'fix','feat']:undefined})},Uri:{file:(value:string)=>value,joinPath:(_root:unknown,...parts:string[])=>parts.join('/')}};
  runInNewContext(readFileSync(file,'utf8'),{exports,require:(name:string)=>name==='vscode'?vscode:load(name)});
  const context={extensionUri:'owned',workspaceState:{get:(key:string,fallback:unknown)=>state.get(key)??fallback,update:async(key:string,value:unknown)=>{state.set(key,value);}}};
  const git={registry:{get active(){return active;},onDidChange:()=>disposable,store:new Map([['repo',{changes:[],operation:'idle',head:'main'}]])},repository:()=>({root:'fixture'})};
  type Composer={resolveWebviewView(view:unknown):Promise<void>;update():Promise<void>;dispose():void};
  const Constructor=exports.CommitComposer as new(context:unknown,git:unknown,commit:()=>Promise<boolean>)=>Composer;
  const composer=new Constructor(context,git,async()=>true);
  const view={visible:true,webview:{html:'',asWebviewUri:String,cspSource:'owned:',onDidReceiveMessage:()=>disposable,postMessage:async(value:Record<string,unknown>)=>{messages.push(value);return true;}},onDidDispose:()=>disposable};
  try{
    await composer.resolveWebviewView(view);assert.deepEqual(messages.filter(item=>item.type==='state').at(-1)!.conventionalTypes,['feat','fix']);
    active=undefined;await composer.update();assert.equal(JSON.stringify(messages.filter(item=>item.type==='state').at(-1)!.conventionalTypes),'[]');
  }finally{composer.dispose();}
});
