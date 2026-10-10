import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolsMutation, buildToolsRead } from '../../src/git/tools/tools-builders';
import { parseStashes, parseTags, parseWorktrees } from '../../src/git/tools/tools-parser';
import { redact } from '../../src/security/redaction';
import { readRepositoryToolsContext } from '../../src/views/tools/repository-tools-context';
const oid='a'.repeat(40);
test('repository tools reject injected selectors, helper URLs and malformed framed output',()=>{
  assert.throws(()=>buildToolsMutation({kind:'stashDrop',selector:'--all',expected:oid}));
  assert.throws(()=>buildToolsMutation({kind:'remoteAdd',name:'origin',url:'ext::command'}));
  assert.throws(()=>buildToolsMutation({kind:'tagRemoteDelete',name:'--all',url:'https://example.test/git',expected:oid}));
  assert.throws(()=>parseStashes(Buffer.from(`stash@{0}\0${oid}\0subject\0`)));
  assert.throws(()=>parseTags(Buffer.from(`refs/tags/a\0${oid}\0\0commit`)));
  assert.throws(()=>parseWorktrees(Buffer.from('worktree /repo\0HEAD invalid\0\0')));
  assert.equal(buildToolsRead({kind:'tags',prefix:'release/'}).at(-1),'refs/tags/release/*');
  assert.equal(buildToolsMutation({kind:'stashCreate',message:'data',untracked:true}).includes('--literal-pathspecs'),false);
  assert.equal(redact('ssh://user:SSH_SECRET_SENTINEL@example.test/repo').includes('SSH_SECRET_SENTINEL'),false);
  assert.equal(redact('https://example.test/repo?%74oken=ENCODED_SECRET_SENTINEL').includes('ENCODED_SECRET_SENTINEL'),false);
});
test('Repository Tools context menu resolves only a valid clicked group or row',()=>{
  assert.deepEqual(readRepositoryToolsContext({kind:'group',group:'Tags',repositoryId:'repo-1'}),{group:'Tags',repositoryId:'repo-1'});
  assert.deepEqual(readRepositoryToolsContext({kind:'row',group:'Worktrees',repositoryId:'repo-1',key:'C:/work/tree'}),{group:'Worktrees',repositoryId:'repo-1',key:'C:/work/tree'});
  assert.equal(readRepositoryToolsContext({label:'not a tools node'}),undefined);
  assert.throws(()=>readRepositoryToolsContext({kind:'row',group:'Tags',repositoryId:'repo-1'}),/Repository Tools/);
  assert.throws(()=>readRepositoryToolsContext({kind:'group',group:'Unknown',repositoryId:'repo-1'}),/Repository Tools/);
});
