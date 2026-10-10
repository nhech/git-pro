import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { InteractivePreview } from '../../git/rebase/interactive.service';
import { validateRebasePlan, type RebaseStep } from '../../git/rebase/rebase-plan';
import { redact } from '../../security/redaction';
import { parsePlannerRequest } from './planner-protocol';
import { plannerHtml } from './planner-html';
export type PlannerChoice=readonly RebaseStep[]|{readonly native:readonly RebaseStep[]}|undefined;
export class RebasePlanner implements vscode.Disposable {
  private readonly panels=new Set<vscode.WebviewPanel>();
  constructor(private readonly context:Pick<vscode.ExtensionContext,'extensionUri'>){}
  choose(preview:InteractivePreview,root:string,edit:(oid:string,initial?:string)=>Promise<string|undefined>,confirm:(steps:readonly RebaseStep[])=>Promise<boolean>=async()=>true):Promise<PlannerChoice>{
    const panel=vscode.window.createWebviewPanel('gitPro.rebasePlanner','Git Pro: Interactive Rebase',vscode.ViewColumn.Active,{enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(this.context.extensionUri,'media')],retainContextWhenHidden:false});
    this.panels.add(panel);const session=randomUUID(),nonce=randomUUID().replace(/-/g,'');
    const steps:RebaseStep[]=preview.commits.map(commit=>({oid:commit.oid,action:'pick'}));let revision=0,busy=false,disposed=false;
    const post=(value:Record<string,unknown>)=>disposed?Promise.resolve(false):panel.webview.postMessage({...value,session});
    const publish=()=>{
      let error:string|undefined;try{validateRebasePlan(preview.commits,steps);}catch(value){error=redact(String(value));}
      return post({type:'state',revision,range:redact(`${root}\nBase ${preview.base} → HEAD ${preview.snapshot.head}`),steps:steps.map(step=>({...step,subject:redact(preview.commits.find(commit=>commit.oid===step.oid)!.subject.slice(0,500)),...(step.message?{message:redact(step.message)}:{})})),error});
    };
    return new Promise(resolve=>{
      let settled=false;const freeze=()=>Object.freeze(steps.map(step=>Object.freeze({...step})));const finish=(result:PlannerChoice)=>{if(settled)return;settled=true;resolve(result);panel.dispose();};
      const receive=panel.webview.onDidReceiveMessage(async raw=>{
        let ownedBusy=false;
        try{
          const request=parsePlannerRequest(raw);if(disposed||request.session!==session)throw new Error('Planner session expired.');
          if(request.type==='ready'){await publish();await post({type:'busy',busy});return;}
          if(busy)throw new Error('Wait for the current planner action.');
          if(request.revision!==revision)throw new Error('Plan changed. Review the current order again.');
          if(request.type==='cancel'||request.type==='native'){finish(request.type==='native'?Object.freeze({native:freeze()}):undefined);return;}
          if(request.type==='review'){
            validateRebasePlan(preview.commits,steps);const frozen=Object.freeze(steps.map(step=>Object.freeze({...step})));
            busy=true;ownedBusy=true;await post({type:'busy',busy:true});if(await confirm(frozen)&&!disposed)finish(frozen);return;
          }
          if(!('oid' in request))throw new Error('Select a captured commit.');
          const index=steps.findIndex(step=>step.oid===request.oid);if(index<0)throw new Error('Commit is outside the captured range.');
          busy=true;ownedBusy=true;await post({type:'busy',busy:true});const selected=steps[index]!;
          if(request.type==='step'){
            const target=index+(request.direction==='up'?-1:1);if(target>=0&&target<steps.length)[steps[index],steps[target]]=[steps[target]!,selected];
          }else if(request.type==='move'){
            const target=steps.findIndex(step=>step.oid===request.target);if(target<0)throw new Error('Drop target is outside the captured range.');
            if(target!==index){steps.splice(index,1);steps.splice(target>index?target-1:target,0,selected);}
          }else if(request.type==='action'||request.type==='message'){
            if(request.type==='message'&&selected.action!=='reword')throw new Error('Select Reword before editing a message.');
            const action=request.type==='action'?request.action:'reword';let message=selected.message;
            if(action==='reword'){message=await edit(selected.oid,message);if(disposed)return;if(message===undefined){await publish();return;}}
            steps[index]={oid:selected.oid,action,...(action==='reword'?{message}: {})};
          }
          revision++;await publish();
        }catch(error){await post({type:'error',message:redact(String(error))});}
        finally{if(ownedBusy){busy=false;await post({type:'busy',busy:false});}}
      });
      const close=panel.onDidDispose(()=>{disposed=true;this.panels.delete(panel);receive.dispose();close.dispose();if(!settled){settled=true;resolve(undefined);}});
      const resource=(name:string)=>panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media',name)).toString();
      panel.webview.html=plannerHtml(session,nonce,panel.webview.cspSource,resource);
    });
  }
  dispose():void{for(const panel of this.panels)panel.dispose();this.panels.clear();}
}
