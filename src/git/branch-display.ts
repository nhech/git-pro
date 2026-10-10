import type { ReadCommand } from './command-builders';
import { validateBranchName } from '../security/refs';

type Read = (command: ReadCommand) => Promise<Buffer>;

/** No config values are read. Invalid or dense key inventories use the full read. */
export function configuredBranchRefs(output: Buffer): string[] | undefined {
  if(output.length>65536)return undefined;
  const text=output.toString('utf8');
  if(!Buffer.from(text).equals(output)||text&&!text.endsWith('\0'))return undefined;
  const refs=new Set<string>();
  for(const key of text?text.slice(0,-1).split('\0'):[]){
    const match=/^branch\.(.+)\.merge$/.exec(key);
    if(!match)return undefined;
    const ref=`refs/heads/${match[1]}`;
    try{validateBranchName(ref);}catch{return undefined;}
    refs.add(ref);
    if(refs.size>200)return undefined;
  }
  const values=[...refs];
  return Buffer.byteLength(values.join('\0'))>12000?undefined:values;
}

function rows(output:Buffer):string[][]|undefined{
  const text=output.toString('utf8');
  if(!Buffer.from(text).equals(output)||text&&!text.endsWith('\n'))return undefined;
  const values=text?text.slice(0,-1).split('\n').map(row=>row.split('\0')):[];
  const seen=new Set<string>();
  for(const row of values){
    if(row.length!==4||!/^refs\/(heads|remotes)\/.+/.test(row[0]!)||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row[1]!)||seen.has(row[0]!))return undefined;
    seen.add(row[0]!);
  }
  return values;
}

/** Display-only; safety previews and mutations retain independent full reads. */
export async function displayBranchOutput(read:Read):Promise<Buffer>{
  const full=()=>read({kind:'branches'});
  const keys=await read({kind:'branchUpstreamKeys'}),configured=configuredBranchRefs(keys);
  if(!configured)return full();
  const identity=await read({kind:'branchIdentities'}),base=rows(identity);
  if(!base||base.some(row=>row[2]!==''))return full();
  const byRef=new Map(base.map(row=>[row[0]!,row]));
  const wanted=configured.filter(ref=>byRef.has(ref));
  if(wanted.length){
    const metadata=rows(await read({kind:'branchUpstreams',refs:wanted}));
    if(!metadata||metadata.length!==wanted.length)return full();
    const wantedSet=new Set(wanted);
    for(const row of metadata){
      const original=byRef.get(row[0]!);
      if(!wantedSet.has(row[0]!)||!original||original[1]!==row[1]||original[3]!==row[3])return full();
      original[2]=row[2]!;
    }
  }
  // Also recheck after zero matches: a branch may acquire tracking while listing.
  if(!(await read({kind:'branchUpstreamKeys'})).equals(keys))return full();
  return wanted.length?Buffer.from(base.map(row=>row.join('\0')).join('\n')+(base.length?'\n':'')):identity;
}
