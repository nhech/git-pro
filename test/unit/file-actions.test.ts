import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHunks } from '../../src/git/files/file-actions.service';
import { buildMutationCommand } from '../../src/git/command-builders';
test('selected hunk framing excludes other hunks and rejects binary, rename, mode and multi-file patches',()=>{
  const header='diff --git a/file b/file\nindex aaaa..bbbb 100644\n--- a/file\n+++ b/file\n';
  const hunks=parseHunks(Buffer.from(header+'@@ -1 +1 @@\n-old\n+new\n@@ -10 +10 @@\n-other\n+next\n'),'file');
  assert.equal(hunks.length,2);assert.equal(hunks[0]!.added,1);assert.equal(hunks[0]!.removed,1);assert.doesNotMatch(hunks[0]!.patch.toString(),/next/);
  assert.throws(()=>parseHunks(Buffer.from(header+'Binary files a/file and b/file differ\n'),'file'));
  assert.throws(()=>parseHunks(Buffer.from(header+'old mode 100644\nnew mode 100755\n@@ -1 +1 @@\n-a\n+b\n'),'file'));
  assert.throws(()=>parseHunks(Buffer.from(header+'rename from old\n@@ -1 +1 @@\n-a\n+b\n'),'file'));
  assert.throws(()=>parseHunks(Buffer.from(header+'@@ -1 +1 @@\n-a\n+b\n'+header),'file'));
  assert.throws(()=>buildMutationCommand({kind:'commitFile',paths:['../outside'],message:'no'}));
  assert.throws(()=>buildMutationCommand({kind:'applyHunk',paths:['file'],direction:'execute' as never,check:false}));
});
test('hunk patches must name the selected file with a/ and b/ prefixes',()=>{
  const body='@@ -1 +1 @@\n-old\n+new\n';
  const patch=(source:string,target:string)=>Buffer.from(`diff --git ${source} ${target}\nindex aaaa..bbbb 100644\n--- ${source}\n+++ ${target}\n${body}`);
  assert.equal(parseHunks(patch('a/sub/a.txt','b/sub/a.txt'),'sub/a.txt').length,1);
  // diff.noprefix=true: `git apply -p1` would strip "sub/" and patch the root a.txt.
  assert.throws(()=>parseHunks(patch('sub/a.txt','sub/a.txt'),'sub/a.txt'),/does not name the selected file/);
  assert.throws(()=>parseHunks(patch('i/sub/a.txt','w/sub/a.txt'),'sub/a.txt'),/does not name the selected file/);
  assert.throws(()=>parseHunks(patch('a/other.txt','b/other.txt'),'sub/a.txt'),/does not name the selected file/);
  // Git appends a tab to ---/+++ names containing a space and C-quotes unusual names.
  const spaced=Buffer.from(`diff --git a/my file b/my file\nindex aaaa..bbbb 100644\n--- a/my file\t\n+++ b/my file\t\n${body}`);
  assert.equal(parseHunks(spaced,'my file').length,1);
  assert.equal(parseHunks(patch('"a/caf\\303\\251 \\"x\\".txt"','"b/caf\\303\\251 \\"x\\".txt"'),'café "x".txt').length,1);
  assert.throws(()=>parseHunks(patch('"a/bad\\q"','"b/bad\\q"'),'bad\\q'),/does not name the selected file/);
});
