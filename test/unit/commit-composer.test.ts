import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import * as path from 'node:path';

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

test('the Conventional Commits choice reads and rewrites only the prefix of the first line, for the types the setting lists',()=>{
  let receive:((event:{data:unknown})=>void)|undefined;const posted:Record<string,unknown>[]=[];
  class Control{
    value='';textContent='';title='';placeholder='';checked=false;disabled=false;hidden=false;open=false;isConnected=true;children:{text:string;value:string}[]=[];dataset:Record<string,string>={};attributes=new Map<string,string>();handlers=new Map<string,((event:Record<string,unknown>)=>void)[]>();
    focus(){document.activeElement=this;}setAttribute(key:string,value:string){this.attributes.set(key,value);}addEventListener(type:string,callback:(event:Record<string,unknown>)=>void){this.handlers.set(type,[...(this.handlers.get(type)??[]),callback]);}fire(type:string){for(const callback of this.handlers.get(type)??[])callback({type});}
    dispatchEvent(event:{type:string}){this.fire(event.type);}click(){this.fire('click');}replaceChildren(...children:{text:string;value:string}[]){this.children=children;}querySelector(){return undefined;}contains(){return false;}
  }
  const ids=['repository','staged','message','warning','amend','signoff','noVerify','commit','commit-label','advanced-label','push','history','clearHistory','result','conventional','cc-type','cc-scope','cc-breaking','commit-menu'];
  const body=new Control(),elements=new Map(ids.map(id=>[id,new Control()]));body.dataset.session='s';
  const document={body,activeElement:body as Control,hasFocus:()=>true,addEventListener:()=>undefined,getElementById:(id:string)=>elements.get(id)};
  runInNewContext(readFileSync('media/commit.js','utf8'),{document,window:{addEventListener:(type:string,callback:typeof receive)=>{if(type==='message')receive=callback;}},navigator:{platform:'Win32'},acquireVsCodeApi:()=>({postMessage:(value:Record<string,unknown>)=>posted.push(value)}),Option:class{constructor(readonly text:string,readonly value:string){}},Event:class{constructor(readonly type:string){}}});
  const message=elements.get('message')!,type=elements.get('cc-type')!,scope=elements.get('cc-scope')!,breaking=elements.get('cc-breaking')!,menu=elements.get('commit-menu')!,group=elements.get('conventional')!;
  const state=(extra:Record<string,unknown>={})=>receive!({data:{type:'state',session:'s',repositoryId:'repo',repository:'repo',message:'',busy:false,staged:1,operation:'idle',subjectLimit:72,history:[],conventionalTypes:['feat','fix','docs','my-type'],...extra}});
  const typed=(value:string)=>{message.value=value;message.fire('input');};
  const choose=(value:string)=>{type.value=value;type.fire('change');};
  state();
  assert.equal(group.hidden,false);assert.deepEqual(type.children.map(item=>item.text),['No type','feat — a new feature','fix — a bug fix','docs — documentation only','my-type']);assert.deepEqual(type.children.map(item=>item.value),['','feat','fix','docs','my-type']);
  assert.equal(scope.disabled,true,'a scope needs a type');assert.equal(breaking.disabled,true);
  const options=type.children;state();assert.equal(type.children,options,'a refresh with the same types leaves the open drop-down alone');

  typed('add parser');assert.equal(type.value,'');
  menu.open=true;choose('feat');
  assert.equal(message.value,'feat: add parser');assert.equal(posted.filter(item=>item.type==='draft').at(-1)?.message,'feat: add parser','the draft follows the rewrite');
  assert.equal(menu.open,false,'choosing a type closes the menu');assert.equal(document.activeElement,message,'and returns to the message');assert.equal(scope.disabled,false);assert.equal(breaking.disabled,false);
  scope.value='api';scope.fire('change');assert.equal(message.value,'feat(api): add parser');
  breaking.checked=true;breaking.fire('change');assert.equal(message.value,'feat(api)!: add parser');
  scope.value=' (a)(b)\n ';scope.fire('change');assert.equal(message.value,'feat(ab)!: add parser','brackets and line breaks cannot end up in the scope');
  scope.value='';scope.fire('change');assert.equal(message.value,'feat!: add parser');

  // Only the first line changes; the body is kept as it is.
  typed('feat(api)!: add parser\n\nBody text\nsecond: line');
  assert.deepEqual([type.value,scope.value,breaking.checked],['feat','api',true],'the controls read the message');
  choose('fix');assert.equal(message.value,'fix(api)!: add parser\n\nBody text\nsecond: line');
  choose('');assert.equal(message.value,'add parser\n\nBody text\nsecond: line');assert.deepEqual([type.value,scope.value,breaking.checked,scope.disabled],['','',false,true]);

  // A prefix that is not one of the listed types is part of the subject, not a type.
  typed('note: keep this');choose('fix');assert.equal(message.value,'fix: note: keep this');
  typed('wip(x): y');assert.equal(type.value,'');typed('Feat: capital');assert.equal(type.value,'');typed('feat:no space');assert.deepEqual([type.value],['feat']);
  typed('my-type(x): y');assert.equal(type.value,'my-type');typed('feat (x): y');assert.equal(type.value,'','a space before the scope is not a prefix');
  typed('');choose('docs');assert.equal(message.value,'docs: ','an empty message gets just the prefix');

  // A draft restored by a refresh (the message box is not focused) is read too; the settings decide what is offered, and none hides the choice.
  document.activeElement=body;state({message:'fix(core): restored'});assert.deepEqual([type.value,scope.value],['fix','core']);
  state({conventionalTypes:['feat']});assert.deepEqual(type.children.map(item=>item.value),['','feat']);assert.equal(type.value,'','fix is no longer a type');
  state({conventionalTypes:['Feat','x'.repeat(30),5,null,'ok-1']});assert.deepEqual(type.children.map(item=>item.value),['','ok-1'],'only lower-case words of at most 20 characters');
  state({conventionalTypes:[]});assert.equal(group.hidden,true);state({conventionalTypes:undefined});assert.equal(group.hidden,true);

  // Nothing is rewritten while a commit runs or without a repository.
  state({message:'add'});const before=message.value;state({busy:true,message:'add'});assert.equal(type.disabled,true);choose('feat');assert.equal(message.value,before);
  state({repositoryId:'',repository:'Choose a repository'});assert.equal(type.disabled,true);
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
