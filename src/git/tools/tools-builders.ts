import * as path from 'node:path';
import { validateBranchName, validateOid } from '../../security/refs';
import { validateRemoteUrl } from '../../security/remotes';
export type ToolsRead={kind:'stashes'}|{kind:'tags';prefix?:string}|{kind:'remoteNames'}|{kind:'remotePrunePreview';remote:string}|{kind:'worktreePrunePreview'}|{kind:'remoteTagRef';url:string;name:string}|
  {kind:'stashFiles';oid:string}|{kind:'tagMessage';name:string};
export type ToolsMutation={kind:'stashCreate';message:string;untracked:boolean}|{kind:'stashApply';oid:string;index:boolean}|
  {kind:'stashDrop';selector:string;expected:string}|{kind:'stashBranch';selector:string;expected:string;name:string}|
  {kind:'tagCreate';name:string;oid:string;message?:string}|{kind:'tagDelete';name:string;expected:string}|
  {kind:'tagCheckout';oid:string}|{kind:'tagBranch';oid:string;name:string}|
  {kind:'tagPush';url:string;tags:readonly {name:string;oid:string}[]}|{kind:'tagRemoteDelete';url:string;name:string;expected:string}|
  {kind:'remoteAdd';name:string;url:string}|{kind:'remoteRemove';name:string}|{kind:'remoteRename';name:string;newName:string}|
  {kind:'remoteSetUrl';name:string;url:string;push:boolean}|{kind:'remotePrune';remote:string}|
  {kind:'branchPush';url:string;localBranch:string;destination:string;source:string}|
  {kind:'worktreeAdd';destination:string;oid:string;branch?:string}|{kind:'worktreeRemove';destination:string}|{kind:'worktreePrune'};
const selector=(value:string)=>{if(!/^stash@\{(?:0|[1-9]\d{0,5})\}$/.test(value))throw new Error('Invalid stash selector.');return value;};
function destination(value:string):string{if(!path.isAbsolute(value)||/[\0\r\n]/.test(value))throw new Error('Worktree requires a reviewed absolute path.');return value;}
function message(value:string):string{if(!value.trim()||value.length>65536||value.includes('\0'))throw new Error('Invalid bounded message.');return value;}
export function buildToolsRead(command:ToolsRead):string[]{
  const prefix=['--literal-pathspecs','--no-pager','-c','color.ui=false'];
  switch(command.kind){
    case 'stashes':return [...prefix,'stash','list','-z','--format=%gd%x00%H%x00%gs%x00%at','--max-count=501'];
    case 'tags':if(command.prefix)validateBranchName(command.prefix+'git-pro-prefix');return [...prefix,'for-each-ref','--count=501','--sort=refname','--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00','refs/tags/'+(command.prefix?command.prefix+'*':'')];
    case 'remoteNames':return [...prefix,'remote'];
    case 'remoteTagRef':return [...prefix,'ls-remote','--refs','--exit-code',validateRemoteUrl(command.url),`refs/tags/${validateBranchName(command.name)}`];
    case 'remotePrunePreview':return [...prefix,'remote','prune','--dry-run',validateBranchName(command.remote)];
    case 'worktreePrunePreview':return [...prefix,'worktree','prune','--dry-run','--verbose'];
    case 'stashFiles':return [...prefix,'stash','show','--include-untracked','--name-status','-z',validateOid(command.oid)];
    case 'tagMessage':return [...prefix,'for-each-ref','--format=%(contents)',`refs/tags/${validateBranchName(command.name)}`];
  }
}
export function buildToolsMutation(command:ToolsMutation):string[]{
  const prefix=['--literal-pathspecs','--no-pager','-c','color.ui=false'];
  switch(command.kind){
    // Git 2.36's stash cleanup inherits literal-pathspecs and leaves untracked
    // files behind. This whole-repository recipe accepts no user pathspecs.
    case 'stashCreate':return [...prefix.slice(1),'stash','push',...(command.untracked?['--include-untracked']:[]),'-m',message(command.message)];
    case 'stashApply':return [...prefix,'stash','apply',...(command.index?['--index']:[]),validateOid(command.oid)];
    case 'stashDrop':validateOid(command.expected);return [...prefix,'stash','drop',selector(command.selector)];
    case 'stashBranch':validateOid(command.expected);return [...prefix,'stash','branch',validateBranchName(command.name),selector(command.selector)];
    case 'tagCreate':return [...prefix,'tag',...(command.message!==undefined?['--annotate','-m',message(command.message)]:[]),validateBranchName(command.name),validateOid(command.oid)];
    case 'tagDelete':return [...prefix,'update-ref','-d',`refs/tags/${validateBranchName(command.name)}`,validateOid(command.expected)];
    case 'tagCheckout':return [...prefix,'checkout','--detach',validateOid(command.oid),'--'];
    case 'tagBranch':return [...prefix,'checkout','-b',validateBranchName(command.name),validateOid(command.oid),'--'];
    case 'tagPush':{
      if(!command.tags.length||command.tags.length>500)throw new Error('Push 1–500 reviewed tags at a time.');
      return [...prefix,'push','--no-follow-tags','--recurse-submodules=no',validateRemoteUrl(command.url),...command.tags.map(tag=>`${validateOid(tag.oid)}:refs/tags/${validateBranchName(tag.name)}`)];
    }
    case 'tagRemoteDelete':{const ref=`refs/tags/${validateBranchName(command.name)}`;return [...prefix,'push','--no-follow-tags','--recurse-submodules=no',`--force-with-lease=${ref}:${validateOid(command.expected)}`,validateRemoteUrl(command.url),`:${ref}`];}
    case 'remoteAdd':return [...prefix,'remote','add',validateBranchName(command.name),validateRemoteUrl(command.url)];
    case 'remoteRemove':return [...prefix,'remote','remove',validateBranchName(command.name)];
    case 'remoteRename':return [...prefix,'remote','rename',validateBranchName(command.name),validateBranchName(command.newName)];
    case 'remoteSetUrl':return [...prefix,'remote','set-url',...(command.push?['--push']:[]),validateBranchName(command.name),validateRemoteUrl(command.url)];
    case 'remotePrune':return [...prefix,'remote','prune',validateBranchName(command.remote)];
    case 'branchPush':validateBranchName(command.localBranch);return [...prefix,'push','--no-follow-tags','--recurse-submodules=no',validateRemoteUrl(command.url),`${validateOid(command.source)}:refs/heads/${validateBranchName(command.destination)}`];
    case 'worktreeAdd':return [...prefix,'worktree','add',...(command.branch?['-b',validateBranchName(command.branch)]:['--detach']),destination(command.destination),validateOid(command.oid)];
    case 'worktreeRemove':return [...prefix,'worktree','remove',destination(command.destination)];
    case 'worktreePrune':return [...prefix,'worktree','prune'];
  }
}
