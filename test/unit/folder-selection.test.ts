import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedPathsInFolder } from '../../src/views/changes/folder-selection';
import type { FileChange } from '../../src/git/git-parser';

test('folder selection is a status-scoped slash-boundary set from changed entries only',()=>{
  const entries:FileChange[]=[
    {path:'src/one/a[1].ts',group:'working',status:'M'},
    {path:'src/one/new.ts',group:'untracked',status:'?'},
    {path:'src/one/staged.ts',group:'staged',status:'M'},
    {path:'src/one-other/not-in-folder.ts',group:'working',status:'M'}
  ];
  assert.deepEqual(changedPathsInFolder(entries,'working','src/one/'),['src/one/a[1].ts']);
  assert.deepEqual(changedPathsInFolder(entries,'untracked','src/one/'),['src/one/new.ts']);
  assert.deepEqual(changedPathsInFolder(entries,'staged','src/one/'),['src/one/staged.ts']);
  for(const prefix of ['../src/','/src/','src/one','src//one/'])assert.throws(()=>changedPathsInFolder(entries,'working',prefix));
});
