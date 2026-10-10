import type { ChangeGroup, FileChange } from '../../git/git-parser';

export function changedPathsInFolder(changes:readonly FileChange[],group:ChangeGroup,prefix:string):string[]{
  if(!prefix||prefix.startsWith('/')||prefix.includes('\0')||!prefix.endsWith('/')||prefix.slice(0,-1).split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('Select a valid changed folder.');
  return [...new Set(changes.filter(change=>change.group===group&&change.path.startsWith(prefix)).map(change=>change.path))];
}
