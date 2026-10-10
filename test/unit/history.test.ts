import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoryRead } from '../../src/git/history/history-builders';
import { parseHistory,verifiedLinearPrefix,parseFollowHistory, parseChangedFiles, parseNumstat,parseComparisonCounts, type HistoryCommit } from '../../src/git/history/history-parser';
import { parseBlame } from '../../src/git/history/blame-parser';
import { layoutGraph } from '../../src/webviews/graph/graph-layout';
import { ReadScheduler } from '../../src/utils/read-scheduler';
import { parseHistoryAction } from '../../src/webviews/graph/history-protocol';
import { buildReadCommand } from '../../src/git/command-builders';

const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), d = 'd'.repeat(40);
test('linear prefix recipe is bounded, OID-only and cannot change history ordering options',()=>{
  const args=buildReadCommand({kind:'historyLinearPrefix',tip:a,limit:101});
  assert.deepEqual(args.slice(-3),['--max-count=101',a,'--']);assert.ok(!args.includes('--topo-order'));
  for(const limit of [0,1,102,1.5,NaN])assert.throws(()=>buildReadCommand({kind:'historyLinearPrefix',tip:a,limit}));
  assert.throws(()=>buildReadCommand({kind:'historyLinearPrefix',tip:'--all',limit:101}));
});
test('linear prefix proof accepts only unique exact chain edges, root completion and a boundary lookahead',()=>{
  const commit=(oid:string,parents:string[]):HistoryCommit=>({oid,parents,author:'Fixture',email:'fixture@example.invalid',timestamp:1,subject:'literal'});
  const chain=[commit(a,[b]),commit(b,[c]),commit(c,[])];assert.equal(verifiedLinearPrefix(chain,a,3),true);
  assert.equal(verifiedLinearPrefix([chain[0]!,chain[1]!,commit(c,[d,a])],a,2),true,'Merge may occur only outside the displayed prefix');
  for(const rows of [[],[commit(b,[])],[commit(a,[b,c]),commit(b,[])],[commit(a,[d]),commit(b,[])],[commit(a,[b])],[commit(a,[a]),commit(a,[])],[...chain,commit(d,[])]])assert.equal(verifiedLinearPrefix(rows,a,3),false);
  assert.equal(verifiedLinearPrefix(chain,a,0),false);assert.equal(verifiedLinearPrefix(chain,a,101),false);
});
test('history HEAD recipe resolves only a fixed commit without a worktree scan', () => {
  const args=buildReadCommand({kind:'historyHead'});
  assert.deepEqual(args.slice(-5),['rev-parse','--verify','--quiet','--end-of-options','HEAD^{commit}']);
  assert.ok(!args.includes('status'));
});
test('single-commit metadata is a bounded validated read without graph traversal or patch output', () => {
  const args=buildReadCommand({kind:'commitMetadata',oid:a});
  assert.ok(args.includes('show'));assert.ok(args.includes('--no-patch'));assert.ok(args.includes('-z'));
  assert.equal(args.at(-2),`${a}^{commit}`);assert.equal(args.at(-1),'--');
  assert.ok(!args.includes('--topo-order'));assert.ok(!args.includes('--max-count=1'));
  for(const oid of ['HEAD','--all',a+'\0extra',a+':secret'])assert.throws(()=>buildReadCommand({kind:'commitMetadata',oid}));
});
test('history protocol rejects forged paths, refs, indexes and non-loaded action shapes', () => {
  assert.deepEqual(parseHistoryAction({type:'select',session:'s',oid:a,parent:1}), {type:'select',session:'s',oid:a,parent:1});
  assert.throws(() => parseHistoryAction({type:'select',session:'s',oid:'--all',parent:0}));
  assert.throws(() => parseHistoryAction({type:'diff',session:'s',index:-1,path:'../outside'}));
  assert.throws(()=>parseHistoryAction({type:'workingDiff',session:'s',index:-1}));assert.deepEqual(parseHistoryAction({type:'workingDiff',session:'s',index:0,path:'../outside'}),{type:'workingDiff',session:'s',index:0});
  assert.throws(() => parseHistoryAction({type:'compare',session:'s',from:'HEAD',to:'x\0y'}));
  assert.deepEqual(parseHistoryAction({type:'comparePage',session:'s',side:'left',offset:25,tip:'--all'}),{type:'comparePage',session:'s',side:'left',offset:25});
  for(const value of [{side:'both',offset:25},{side:'right',offset:-25},{side:'right',offset:26},{side:'left',offset:1_000_025}])assert.throws(()=>parseHistoryAction({type:'comparePage',session:'s',...value}));
  assert.throws(()=>parseHistoryAction({type:'copy',session:'s',oid:a,field:'arbitrary-path'}));
  assert.deepEqual(parseHistoryAction({type:'copy',session:'s',oid:a,field:'hash'}),{type:'copy',session:'s',oid:a,field:'hash'});
  assert.throws(() => parseHistoryAction({type:'query',session:'s',ref:'HEAD',text:'a'.repeat(501),author:'',path:'',from:'',to:''}));
});
test('history recipes pin validated OIDs, cap pages and escape literal filters', () => {
  assert.ok(buildReadCommand({kind:'ref',ref:'HEAD~1^2'}).includes('HEAD~1^2^{commit}'));
  assert.throws(()=>buildReadCommand({kind:'ref',ref:'HEAD:file.txt'}));
  assert.throws(()=>buildReadCommand({kind:'ref',ref:'HEAD~1000001'}));
  const argv = buildHistoryRead({ kind: 'history', tips: [a], offset: 100, limit: 101, filters: { author: 'A.*', text: '[fix]', path: '-option[1].txt', from: '2026-01-01' } });
  assert.ok(argv.includes('--author=A\\.\\*')); assert.ok(argv.includes('--fixed-strings')); assert.equal(argv.at(-1), '-option[1].txt');
  assert.throws(() => buildHistoryRead({ kind: 'history', tips: ['--all'], offset: 0, limit: 100 }));
  assert.throws(() => buildHistoryRead({ kind: 'history', tips: [a], offset: 0, limit: 102 }));
  assert.ok(buildHistoryRead({kind:'historyWindow',tips:[a],offset:200,limit:501}).includes('--max-count=501'));
  assert.throws(()=>buildHistoryRead({kind:'historyWindow',tips:[a],offset:0,limit:502}));
  assert.throws(()=>buildHistoryRead({kind:'historyWindow',tips:['--all'],offset:0,limit:501}));
  assert.throws(() => buildHistoryRead({ kind: 'history', tips: [a], offset: 0, limit: 100, filters: { from: '2026-02-31' } }));
  assert.throws(() => buildHistoryRead({ kind: 'blame', path: '../outside', line: 1 }));
  assert.ok(buildReadCommand({kind:'comparisonCommits',tip:a,exclude:b}).includes('--left-only'));assert.ok(buildReadCommand({kind:'comparisonCommits',tip:a,exclude:b}).includes(`${a}...${b}`));assert.ok(buildReadCommand({kind:'comparisonCount',from:a,to:b}).includes(`${a}...${b}`));
  assert.throws(()=>buildReadCommand({kind:'comparisonCommits',tip:a,exclude:'--all'}));
  assert.ok(buildReadCommand({kind:'followHistory',tip:a,path:'new [1].txt',limit:101}).includes('--follow'));assert.throws(()=>buildReadCommand({kind:'followHistory',tip:a,path:'../outside',limit:1}));
  assert.ok(buildReadCommand({kind:'comparisonCommits',tip:a,exclude:b,offset:25}).includes('--skip=25'));assert.throws(()=>buildReadCommand({kind:'comparisonCommits',tip:a,exclude:b,offset:-1}));assert.throws(()=>buildReadCommand({kind:'comparisonCommits',tip:a,exclude:b,offset:1_000_001}));
});
test('history framing, rename paths and binary numstat remain distinct', () => {
  assert.deepEqual(parseComparisonCounts(Buffer.from('2\t3\n')),{left:2,right:3});assert.throws(()=>parseComparisonCounts(Buffer.from('1 x')));assert.throws(()=>parseComparisonCounts(Buffer.from('9007199254740992 0')));
  const record = Buffer.from([a, `${b} ${c}`, 'Author', 'email@example.invalid', '1700000000', 'subject', ''].join('\0'));
  assert.deepEqual(parseHistory(record)[0]?.parents, [b, c]);
  assert.throws(() => parseHistory(record.subarray(0, record.length - 1)));
  assert.throws(() => parseHistory(Buffer.from('bad\0')));
  const followRecord=Buffer.from(['',a,b,'Author','email@example.invalid','1700000000','subject','subject\n\nBody keep\n','1700000001','\nR100','old\tname','new\nname',''].join('\0'));
  const followed=parseFollowHistory(followRecord)[0]!;assert.equal(followed.file.originalPath,'old\tname');assert.equal(followed.file.path,'new\nname');assert.match(followed.message,/Body keep/);assert.equal(followed.committerTimestamp,1700000001);
  assert.throws(()=>parseFollowHistory(followRecord.subarray(0,followRecord.length-1)));assert.throws(()=>parseFollowHistory(Buffer.concat([followRecord,Buffer.from('M\0another.txt\0')])));
  const files = parseChangedFiles(Buffer.from('R100\0old\tname\0new\nname\0M\0日本語.txt\0'));
  assert.equal(files[0]?.originalPath, 'old\tname'); assert.equal(files[0]?.path, 'new\nname');
  const stats = parseNumstat(Buffer.from('2\t3\t\0old\0new\0-\t-\tbinary\0'));
  assert.deepEqual(stats[0], { path: 'new', originalPath: 'old', added: 2, removed: 3 }); assert.equal(stats[1]?.added, null);
  assert.throws(() => parseNumstat(Buffer.from('1\t2\t\0old\0')));
});
test('graph carries merge/shared-parent lanes across pages without losing boundary edges', () => {
  const first = layoutGraph([{ oid: a, parents: [b, c] }, { oid: b, parents: [d] }]);
  assert.deepEqual(first.continuation, [d, c]); assert.ok(first.rows[0]?.edges.some(edge => edge.oid === c && edge.boundary));
  const second = layoutGraph([{ oid: c, parents: [d] }, { oid: d, parents: [] }], first.continuation);
  assert.equal(second.rows[0]?.lane, 1); assert.deepEqual(second.continuation, []);
  assert.equal(second.rows[0]?.edges.filter(edge => edge.oid === d).length, 2);
});
test('blame preserves source text and suppresses zero-hash commit actions', () => {
  const line = parseBlame(Buffer.from(`${'0'.repeat(40)} 1 2 1\nauthor Not Committed Yet\nauthor-time 1700000000\nsummary Working\nfilename a.txt\n\t<x> text\n`));
  assert.equal(line.uncommitted, true); assert.equal(line.content, '<x> text');
  assert.throws(() => parseBlame(Buffer.from(`${a} 1 1\nauthor Test\n`)));
});
test('read scheduler bounds concurrency and cancels queued tasks before execution', async () => {
  const scheduler = new ReadScheduler(1); let release!: () => void; let ran = false;
  const first = scheduler.run(() => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve(); const controller = new AbortController();
  const second = scheduler.run(async () => { ran = true; }, controller.signal); controller.abort();
  await assert.rejects(second, /cancelled/); release(); await first; assert.equal(ran, false); scheduler.dispose();
  await assert.rejects(scheduler.run(async () => undefined), /cancelled/);
});
