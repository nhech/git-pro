export const repositoryToolGroups=['Stashes','Tags','Remotes','Worktrees'] as const;
export type RepositoryToolGroup=typeof repositoryToolGroups[number];
export type RepositoryToolsContext={group:RepositoryToolGroup;repositoryId:string;key?:string};

export function readRepositoryToolsContext(value:unknown):RepositoryToolsContext|undefined{
  if(!value||typeof value!=='object'||!('kind' in value))return undefined;
  const node=value as {kind?:unknown;group?:unknown;repositoryId?:unknown;key?:unknown};
  if((node.kind!=='group'&&node.kind!=='row')||typeof node.group!=='string'||!repositoryToolGroups.includes(node.group as RepositoryToolGroup)||typeof node.repositoryId!=='string'||!node.repositoryId||(node.kind==='row'&&(typeof node.key!=='string'||!node.key)))throw new Error('Select a Repository Tools group or entry.');
  return {group:node.group as RepositoryToolGroup,repositoryId:node.repositoryId,...(node.kind==='row'?{key:node.key as string}:{})};
}
