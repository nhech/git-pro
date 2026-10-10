import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

test('native hunk picker preserves direction/index/patch binding and plain confirmation labels; cancellation never applies',async()=>{
  const source=path.resolve(__dirname,'../../src/commands/file-actions.commands.js'),load=createRequire(source);
  for(const direction of ['stage','unstage','revert'] as const)for(const cancelAt of [0,1,2,3]){
    const choices:Record<string,unknown>[][]=[],buttons:string[]=[],applied:unknown[][]=[],opened:unknown[][]=[],requested:string[]=[];
    const patches=[Buffer.from('first exact patch'),Buffer.from('second exact patch')],preview={snapshot:{head:'a'.repeat(40)},hunks:[{label:'@@ -2,7 +2,7 @@ $(trash)',added:1,removed:1,patch:patches[0]},{label:'@@ -47,7 +47,0 @@ $(warning)',added:0,removed:7,patch:patches[1]}]};
    class Service {
      async hunks(_id:string,_file:string,value:string){requested.push(value);return preview;}
      async apply(value:unknown,index:number){applied.push([value,index]);}
    }
    class ThemeColor {constructor(readonly id:string){}}
    class ThemeIcon {constructor(readonly id:string,readonly color:ThemeColor){}}
    const vscode={ThemeIcon,ThemeColor,workspace:{textDocuments:[]},window:{
      showQuickPick:async(items:Record<string,unknown>[])=>{choices.push(items);return cancelAt===choices.length?undefined:choices.length===1?items.find(item=>item.direction===direction):items[1];},
      showWarningMessage:async(_text:string,_options:unknown,button:string)=>{buttons.push(button);return cancelAt===3?undefined:button;},
    },commands:{executeCommand:async(...args:unknown[])=>{opened.push(args);}}};
    const exports:Record<string,unknown>={};
    runInNewContext(readFileSync(source,'utf8'),{exports,require:(name:string)=>name==='vscode'?vscode:name==='../git/files/file-actions.service'?{FileActionsService:Service}:name==='../security/paths'?{canonicalFilePath:async(value:string)=>value}:name==='./message-editor'?{editMessage:()=>{throw new Error('Hunk selection must not open the commit-message editor.');}}:load(name)});
    const Constructor=exports.FileActionsCommands as new(advanced:unknown,revisions:unknown)=>{hunks(arg:unknown):Promise<void>};
    const patchUris:Buffer[]=[];
    const command=new Constructor({git:{authorizePath:async()=>'/owned/file.txt',repository:()=>({root:'/owned'})}},{add:(patch:Buffer)=>{patchUris.push(patch);return 'readonly-patch';}});
    await command.hunks({kind:'file',repositoryId:'owned',change:{path:'file.txt'}});
    const action=choices[0]!.find(item=>item.direction===direction)!;
    assert.equal(action.label,direction==='stage'?'Stage Hunk':direction==='unstage'?'Unstage Hunk':'Revert Hunk');assert.ok(action.iconPath instanceof ThemeIcon);
    if(cancelAt===1){assert.deepEqual(requested,[]);assert.deepEqual(applied,[]);continue;}
    assert.deepEqual(requested,[direction]);
    assert.equal(choices[1]![0]!.label,'Hunk 1 · Lines 2–8');assert.equal(choices[1]![1]!.label,'Hunk 2 · After line 47');
    assert.ok(choices[1]!.every(item=>!String(item.label).includes('$(')&&!String(item.detail).includes('$(')),'Header context cannot create misleading picker icons.');
    if(cancelAt===2){assert.deepEqual(patchUris,[]);assert.deepEqual(applied,[]);continue;}
    assert.equal(patchUris[0],patches[1]);assert.deepEqual(opened,[['vscode.open','readonly-patch']]);assert.equal(buttons[0],action.label);assert.doesNotMatch(buttons[0]!,/\$\(/);
    if(cancelAt===3)assert.deepEqual(applied,[]);else {assert.equal(applied.length,1);assert.equal(applied[0]![0],preview);assert.equal(applied[0]![1],1);}
  }
});
