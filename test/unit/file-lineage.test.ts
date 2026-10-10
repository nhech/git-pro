import {test} from 'node:test';
import assert from 'node:assert/strict';
import {historyEdgeInput,buildHistoryRead} from '../../src/git/history/history-builders';
import {parseHistoryEdges,parseLineageHistory,advanceFileCursor,initialFileCursor,type LineageCommit} from '../../src/git/history/file-lineage';
const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40);
const oid=(index:number)=>index.toString(16).padStart(40,'0');
const commit=(index:number,parent?:number):LineageCommit=>({commit:{oid:oid(index),parents:parent===undefined?[]:[oid(parent)],author:'Author',email:'author@example.invalid',timestamp:1700000000,subject:'subject'},message:'subject\n\nbody',committerTimestamp:1700000000});
test('lineage recipes and edge parser retain selected parent identities and reject injection/truncation/order',()=>{
  assert.equal(historyEdgeInput([{child:a,parent:b},{child:a,parent:c}]).toString(),`${a} ${b}\n${a} ${c}\n`);
  for(const edges of [[{child:'--all'}],[{child:a,parent:b+'\n'+c}],[{child:a},{child:a}],Array.from({length:1025},(_,index)=>({child:oid(index)}))])assert.throws(()=>historyEdgeInput(edges));
  assert.ok(buildHistoryRead({kind:'lineageHistory',tip:a,offset:100,limit:101}).includes('--topo-order'));
  assert.throws(()=>buildHistoryRead({kind:'lineageHistory',tip:a,offset:1_000_001,limit:101}));
  const input=Buffer.from(`\0${a}\0${b}\0\0\nR100\0old\t日本語\0new\nname\0\0${a}\0${c}\0\0`),expected=[{child:a,parent:b},{child:a,parent:c}];
  const parsed=parseHistoryEdges(input,expected);assert.equal(parsed[0]!.files[0]!.originalPath,'old\t日本語');assert.equal(parsed[0]!.files[0]!.path,'new\nname');assert.equal(parsed[1]!.files.length,0);
  assert.throws(()=>parseHistoryEdges(input.subarray(0,-1),expected));assert.throws(()=>parseHistoryEdges(input,expected.slice().reverse()));assert.throws(()=>parseHistoryEdges(input,[expected[0]!]));
  assert.throws(()=>parseHistoryEdges(Buffer.from(`\0${a}\0${b}\0\0\nM\0../outside\0`),[expected[0]!]));
  const metadata=Buffer.from([a,b,'Author','author@example.invalid','1700000000','subject','subject\n\nbody','1700000001',''].join('\0'));
  assert.equal(parseLineageHistory(metadata)[0]!.message,'subject\n\nbody');assert.throws(()=>parseLineageHistory(metadata.subarray(0,-1)));assert.throws(()=>parseLineageHistory(Buffer.from('bad\0')));
});
test('empty bounded scans continue without mutating the old cursor; cancellation preserves retry state',async()=>{
  const cursor=initialFileCursor(oid(2000),'file.txt');
  const readHistory=async(offset:number)=>Array.from({length:101},(_,index)=>commit(2000-offset-index,1999-offset-index));
  const readEdges=async(edges:readonly {child:string;parent?:string}[])=>edges.map(edge=>({...edge,files:[]}));
  const page=await advanceFileCursor(cursor,{},100,readHistory,readEdges);assert.equal(page.commits.length,0);assert.equal(page.scanned,1000);assert.equal(page.hasMore,true);assert.equal(page.cursor.scanOffset,1000);assert.equal(cursor.scanOffset,0);assert.ok(cursor.frontier.has(oid(2000)));
  const control=new AbortController();await assert.rejects(advanceFileCursor(cursor,{},100,readHistory,async edges=>{control.abort();return readEdges(edges);},control.signal),/cancelled/);
  assert.equal(cursor.scanOffset,0);assert.ok(cursor.frontier.has(oid(2000)));assert.equal((await advanceFileCursor(page.cursor,{},100,readHistory,readEdges)).cursor.scanOffset,2000);
});
test('frontier state and serialized-byte limits reject expansion rather than dropping parent branches',async()=>{
  const cursor=initialFileCursor(a,'file.txt'),parents=Array.from({length:1001},(_,index)=>oid(index+1));
  await assert.rejects(advanceFileCursor(cursor,{},1,async()=>[{...commit(1),commit:{...commit(1).commit,oid:a,parents}}],async edges=>edges.map(edge=>({...edge,files:[{status:'M',path:'file.txt'}]}))),/frontier limit/);
  assert.ok(cursor.frontier.has(a));
  const oversized={...cursor,frontier:new Map(Array.from({length:1000},(_,index)=>[oid(index+1),new Set(['x'.repeat(600)])]))};
  await assert.rejects(advanceFileCursor(oversized,{},1,async()=>[],async()=>[]),/frontier limit/);
});
test('replacement at a renamed-away source stops at the new addition instead of borrowing the old lineage',async()=>{
  const cursor=initialFileCursor(a,'old.txt'),metadata={...commit(1),commit:{...commit(1).commit,oid:a,parents:[b]}};
  const result=await advanceFileCursor(cursor,{},100,async()=>[metadata],async()=>[{child:a,parent:b,files:[{status:'R100',originalPath:'old.txt',path:'new.txt'},{status:'A',path:'old.txt'}]}]);
  assert.deepEqual(result.paths,[{oid:a,path:'old.txt'}]);assert.equal(result.hasMore,false);assert.equal(result.cursor.frontier.size,0);
});
