import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

test('resource auto-fetch schedules distinct repositories, isolates backoff and disposes pending work',async()=>{
  let now=0,timer:{callback:()=>void;delay:number}|undefined,onTimer:()=>void=()=>undefined;
  const events=new Map<string,()=>void>(),subscribe=(name:string)=>(callback:()=>void)=>{events.set(name,callback);return{dispose:()=>events.delete(name)};};
  let repositories=[{id:'a',root:'/a'},{id:'b',root:'/b'}];const config=new Map([['/a',{enabled:true,minutes:1}],['/b',{enabled:true,minutes:2}]]);
  const calls:string[]=[],errors:string[]=[];let active=0,maxActive=0;
  const git={registry:{list:()=>repositories,onDidChange:subscribe('repositories'),store:{get:()=>({operation:'idle'})}},remotes:async()=>[{name:'origin'}],fetch:async(id:string)=>{active++;maxActive=Math.max(maxActive,active);calls.push(id);await Promise.resolve();active--;if(id==='b')throw new Error('Auth failed');}};
  const vscode={Uri:{file:(fsPath:string)=>({fsPath})},workspace:{onDidChangeConfiguration:(callback:(event:{affectsConfiguration:()=>boolean})=>void)=>subscribe('configuration')(()=>callback({affectsConfiguration:()=>true})),getConfiguration:(_section:string,uri:{fsPath:string})=>({get:(key:string,fallback:unknown)=>key==='autoFetch.enabled'?config.get(uri.fsPath)?.enabled:key==='autoFetch.intervalMinutes'?config.get(uri.fsPath)?.minutes:fallback})}};
  const exports:Record<string,unknown>={},load=createRequire(path.resolve(__dirname,'../../src/git/auto-fetch.js'));
  runInNewContext(readFileSync(path.resolve(__dirname,'../../src/git/auto-fetch.js'),'utf8'),{exports,require:(name:string)=>name==='vscode'?vscode:load(name),Date:{now:()=>now},setTimeout:(callback:()=>void,delay:number)=>{timer={callback,delay};onTimer();return timer;},clearTimeout:()=>{timer=undefined;}});
  const AutoFetch=exports.AutoFetch as new(git:unknown,logger:unknown)=>{dispose():void};const instance=new AutoFetch(git,{error:(message:string)=>errors.push(message)});
  const tick=async()=>{assert.ok(timer);now+=timer.delay;const callback=timer.callback;let timeout:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([new Promise<void>(resolve=>{onTimer=resolve;callback();}),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Auto-fetch did not reschedule.')),1000);})]);}finally{onTimer=()=>undefined;if(timeout)clearTimeout(timeout);}};
  assert.equal(timer?.delay,60_000);await tick();assert.deepEqual(calls,['a']);assert.equal(timer?.delay,60_000);
  config.get('/a')!.enabled=false;events.get('configuration')!();await tick();assert.deepEqual(calls,['a','b']);assert.equal(timer?.delay,240_000);assert.equal(errors.length,1);assert.equal(maxActive,1);
  repositories=[];events.get('repositories')!();assert.equal(timer,undefined);
  instance.dispose();assert.equal(events.size,0);assert.deepEqual(calls,['a','b']);
});
