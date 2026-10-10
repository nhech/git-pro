import * as vscode from 'vscode';
import type { GitService } from './git.service';
import type { Logger } from '../utils/logging';
import { boundedInteger } from '../utils/settings';

export class AutoFetch implements vscode.Disposable {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private running = false;
  private readonly due=new Map<string,{at:number;failures:number;interval:number}>();
  private readonly subscriptions: vscode.Disposable[];
  constructor(private readonly git: GitService, private readonly logger: Logger) {
    this.subscriptions = [vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('gitPro.autoFetch')) this.schedule(); }),git.registry.onDidChange(()=>this.schedule())];
    this.schedule();
  }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if(this.disposed||this.running)return;
    const now=Date.now(),enabled=new Set<string>();
    for(const repo of this.git.registry.list()){
      const config=vscode.workspace.getConfiguration('gitPro',vscode.Uri.file(repo.root));
      if(!config.get<boolean>('autoFetch.enabled',false))continue;
      enabled.add(repo.id);const interval=boundedInteger(config.get('autoFetch.intervalMinutes'),5,1,60)*60_000,existing=this.due.get(repo.id);
      if(!existing||existing.interval!==interval)this.due.set(repo.id,{at:now+interval,failures:0,interval});
    }
    for(const id of this.due.keys())if(!enabled.has(id))this.due.delete(id);
    if(this.due.size)this.timer=setTimeout(()=>{this.timer=undefined;void this.fetch();},Math.max(1,Math.min(...[...this.due.values()].map(item=>item.at))-now));
  }
  private async fetch(): Promise<void> {
    if (this.disposed || this.running) { this.schedule(); return; }
    this.running = true;
    try {
      for (const repo of this.git.registry.list()) {
        if(this.disposed)break;const entry=this.due.get(repo.id),config=vscode.workspace.getConfiguration('gitPro',vscode.Uri.file(repo.root));
        if(!entry||entry.at>Date.now()||!config.get<boolean>('autoFetch.enabled',false))continue;
        if(this.git.registry.store.get(repo.id)?.operation!=='idle'){entry.at=Date.now()+entry.interval;continue;}
        try{
          for(const remote of await this.git.remotes(repo.id)){
            if(this.disposed||!vscode.workspace.getConfiguration('gitPro',vscode.Uri.file(repo.root)).get<boolean>('autoFetch.enabled',false))break;
            await this.git.fetch(repo.id,remote.name);
          }
          entry.failures=0;
        }catch{entry.failures=Math.min(3,entry.failures+1);this.logger.error('Auto-fetch failed; retry delayed for this repository. Use Fetch for interactive error recovery.');}
        entry.at=Date.now()+entry.interval*2**entry.failures;
      }
    } finally { this.running = false; this.schedule(); }
  }
  dispose(): void { this.disposed = true; if (this.timer) clearTimeout(this.timer); for(const subscription of this.subscriptions)subscription.dispose();this.due.clear(); }
}
