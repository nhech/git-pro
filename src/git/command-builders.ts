import { buildHistoryRead, type HistoryReadCommand } from './history/history-builders';
import { buildAdvancedMutation, type AdvancedMutation } from './advanced/advanced-builders';
import { validateRemoteUrl } from '../security/remotes';
import { buildToolsRead, buildToolsMutation, type ToolsRead, type ToolsMutation } from './tools/tools-builders';
export const markers = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD',
  'REVERT_HEAD', 'BISECT_LOG', 'sequencer'] as const;
export type Marker = typeof markers[number];
/** Typed read recipes, separate from coordinated mutation recipes below. */
export type ReadCommand = { kind: 'version' } | { kind: 'status' } | { kind: 'historyHead' } | { kind: 'index'; paths?: readonly string[] } |
  {kind:'filePatch';path:string;index:boolean} | { kind: 'branches' | 'branchIdentities' | 'branchUpstreamKeys' | 'branchConfig' } | {kind:'branchUpstreams';refs:readonly string[]} | { kind: 'worktrees' } | { kind: 'workDiff'; paths: readonly string[] } |
  { kind: 'tree'; oid: string; path: string } | { kind: 'blobSize' | 'blob'; oid: string } |
  { kind: 'ref'; ref: string } | {kind:'linearRange';base:string;tip:string} | {kind:'remoteUrls';remote:string;push:boolean} | {kind:'remoteRef';url:string;branch:string} |
  { kind: 'metadata'; field: 'root' | 'gitDir' | 'commonDir' } | { kind: 'marker'; marker: Marker } | HistoryReadCommand | ToolsRead;

export function buildReadCommand(command: ReadCommand): string[] {
  const prefix = ['--no-pager', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false'];
  switch (command.kind) {
    case 'version': return ['--version'];
    case 'status': return [...prefix, 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'];
    case 'historyHead': return [...prefix, 'rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'];
    case 'index': return ['--literal-pathspecs', ...prefix, 'ls-files', '--stage', '-z', '--', ...(command.paths ?? [])];
    // Explicit prefixes override diff.noprefix/mnemonicPrefix/srcPrefix so `git apply` (-p1) targets the same file.
    case 'filePatch': return ['--literal-pathspecs',...prefix,'diff','--no-color','--no-ext-diff','--no-textconv','--src-prefix=a/','--dst-prefix=b/','--full-index','--unified=3',...(command.index?['--cached']:[]),'--',...safePaths([command.path])];
    case 'branches': return [...prefix, 'for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(worktreepath)', 'refs/heads/', 'refs/remotes/'];
    case 'branchIdentities': return [...prefix,'for-each-ref','--format=%(refname)%00%(objectname)%00%00%(worktreepath)','refs/heads/','refs/remotes/'];
    case 'branchUpstreamKeys': return [...prefix,'config','--null','--name-only','--includes','--get-regexp','^branch\\..*\\.merge$'];
    case 'branchConfig': return [...prefix,'config','--null','--includes','--get-regexp','^branch\\.'];
    case 'branchUpstreams': {
      if(!command.refs.length||command.refs.length>200||Buffer.byteLength(command.refs.join('\0'))>12000)throw new Error('Branch metadata request exceeds its bound.');
      const refs=command.refs.map(ref=>{if(!ref.startsWith('refs/heads/'))throw new Error('Select full local branch refs.');return validateBranchName(ref);});
      return [...prefix,'for-each-ref','--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(worktreepath)',...refs];
    }
    case 'worktrees': return [...prefix, 'worktree', 'list', '--porcelain', '-z'];
    case 'workDiff': return ['--literal-pathspecs', ...prefix, 'diff', '--no-ext-diff', '--no-textconv', '--binary', '--', ...command.paths];
    case 'tree': return ['--literal-pathspecs', ...prefix, 'ls-tree', '-z', validateOid(command.oid), '--', command.path];
    case 'blobSize': return [...prefix, 'cat-file', '-s', validateOid(command.oid)];
    case 'blob': return [...prefix, 'cat-file', 'blob', validateOid(command.oid)];
    case 'ref': return [...prefix, 'rev-parse', '--verify', '--end-of-options', `${validateRef(command.ref)}^{commit}`];
    case 'remoteUrls': return [...prefix,'remote','get-url','--all',...(command.push?['--push']:[]),validateBranchName(command.remote)];
    case 'remoteRef': return [...prefix,'ls-remote','--refs','--exit-code',validateRemoteUrl(command.url),`refs/heads/${validateBranchName(command.branch)}`];
    case 'linearRange': return [...prefix,'rev-list','--reverse','--parents','--max-count=201',`${validateOid(command.base)}..${validateOid(command.tip)}`,'--'];
    case 'metadata': {
      const fields = { root: '--show-toplevel', gitDir: '--absolute-git-dir', commonDir: '--git-common-dir' };
      if (!(command.field in fields)) throw new Error('Unsupported metadata field.');
      return [...prefix, 'rev-parse', fields[command.field]];
    }
    case 'marker':
      if (!markers.includes(command.marker)) throw new Error('Unsupported operation marker.');
      return [...prefix, 'rev-parse', '--git-path', command.marker];
    case 'history':case 'historyWindow':case 'rangeMessages':case 'historyLinearPrefix':case 'followHistory':case 'lineageHistory':case 'historyEdges': case 'comparisonCommits':case 'comparisonCount':case 'commitMetadata':case 'commitMessage': case 'containingRefs': case 'changedFiles': case 'numstat': case 'blame':
      return buildHistoryRead(command);
    case 'stashes': case 'tags': case 'remoteNames': case 'remotePrunePreview': case 'worktreePrunePreview': case 'stashFiles': case 'tagMessage': case 'remoteTagRef':
      return buildToolsRead(command);
    default: throw new Error('Unsupported Git request.');
  }
}

import { validateBranchName, validateOid } from '../security/refs';
function validateRef(ref: string): string {
  if (typeof ref !== 'string' || ref.length > 4096 || ref.includes('\0')) throw new Error('Invalid revision.');
  const ancestry = /^(.+?)((?:[~^]\d+){1,16})$/.exec(ref);
  if (ancestry) {
    const suffix = ancestry[2]!;
    if ([...suffix.matchAll(/[~^](\d+)/g)].some(part => Number(part[1]) > 1_000_000)) throw new Error('Revision ancestry is too large.');
    return validateRef(ancestry[1]!) + suffix;
  }
  if (ref === 'HEAD') return ref;
  if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(ref)) return validateOid(ref);
  validateBranchName(ref); return ref;
}
export type MutationCommand = {kind:'applyHunk';paths:readonly string[];direction:'stage'|'unstage'|'revert';check:boolean} | {kind:'commitFile';paths:readonly string[];message:string} | { kind: 'stage' | 'unstage' | 'unstageUnborn' | 'discard'; paths: readonly string[] } |
  { kind: 'renameBranch'; oldName: string; newName: string } | { kind: 'unsetUpstream'; branch: string } |
  { kind: 'integrate'; strategy: 'ff-only' | 'merge' | 'rebase'; oid: string } |
  { kind: 'acceptConflict'; side: 'ours'|'theirs'; paths: readonly string[] } |
  { kind: 'deleteConflict'; paths: readonly string[] } | {kind:'pushLease';url:string;branch:string;source:string;expected:string} | AdvancedMutation | ToolsMutation;
export function buildMutationCommand(command: MutationCommand): string[] {
  const prefix = ['--literal-pathspecs', '--no-pager', '-c', 'color.ui=false'];
  switch (command.kind) {
    case 'applyHunk': if(!['stage','unstage','revert'].includes(command.direction)||typeof command.check!=='boolean'||command.paths.length!==1)throw new Error('Invalid hunk application.');return [...prefix,'apply','--whitespace=nowarn',...(command.direction==='revert'?[]:['--cached']),...(command.direction==='stage'?[]:['--reverse']),...(command.check?['--check']:[]),'--','-'];
    case 'commitFile':if(command.paths.length!==1||!command.message.trim()||command.message.includes('\0')||command.message.length>65536)throw new Error('Review one file and a bounded commit message.');return [...prefix,'commit','--only','-m',command.message,'--',...safePaths(command.paths)];
    // Path lists travel on stdin (see pathspecInput): one process however long the list, so nothing is applied in part.
    case 'stage': return [...prefix, 'add', ...fromStdin(command.paths)];
    case 'unstage': return [...prefix, 'restore', '--staged', ...fromStdin(command.paths)];
    case 'unstageUnborn': return [...prefix, 'rm', '--cached', '-f', ...fromStdin(command.paths)];
    case 'discard': return [...prefix, 'restore', '--worktree', ...fromStdin(command.paths)];
    case 'acceptConflict': {
      if (!['ours','theirs'].includes(command.side)) throw new Error('Invalid conflict side.');
      return [...prefix,'restore',`--${command.side}`,'--worktree',...fromStdin(command.paths)];
    }
    case 'deleteConflict': return [...prefix,'rm','-f',...fromStdin(command.paths)];
    case 'pushLease': {
      const ref=`refs/heads/${validateBranchName(command.branch)}`;
      return [...prefix,'push','--no-follow-tags','--recurse-submodules=no',`--force-with-lease=${ref}:${validateOid(command.expected)}`,validateRemoteUrl(command.url),`${validateOid(command.source)}:${ref}`];
    }
    case 'renameBranch': return [...prefix, 'branch', '-m', validateBranchName(command.oldName), validateBranchName(command.newName)];
    case 'unsetUpstream': return [...prefix, 'branch', '--unset-upstream', validateBranchName(command.branch)];
    case 'integrate': {
      const oid = validateOid(command.oid);
      if (command.strategy === 'rebase') return [...prefix, '-c', 'rebase.updateRefs=false', 'rebase', '--no-autostash', oid];
      if (command.strategy === 'merge') return [...prefix, 'merge', '--ff', '--no-autostash', '--no-edit', oid];
      if (command.strategy === 'ff-only') return [...prefix, 'merge', '--ff-only', '--no-autostash', oid];
      throw new Error('Invalid pull strategy.');
    }
    case 'merge': case 'rebase': case 'interactiveRebase': case 'amendStopped': case 'cherryPick': case 'revert': case 'reset': case 'operationControl':
      return buildAdvancedMutation(command);
    case 'stashCreate': case 'stashApply': case 'stashDrop': case 'stashBranch': case 'tagCreate': case 'tagDelete': case 'tagCheckout': case 'tagBranch': case 'tagPush': case 'tagRemoteDelete': case 'remoteAdd': case 'remoteRemove': case 'remoteRename': case 'remoteSetUrl': case 'remotePrune': case 'branchPush': case 'worktreeAdd': case 'worktreeRemove': case 'worktreePrune':
      return buildToolsMutation(command);
    default: throw new Error('Unsupported mutation.');
  }
}
/** Validated paths for `--pathspec-from-file=- --pathspec-file-nul`; `--literal-pathspecs` applies to them as to argv paths. */
export function pathspecInput(paths: readonly string[]): Buffer { return Buffer.from(safePaths(paths).map(value => `${value}\0`).join('')); }
function fromStdin(paths: readonly string[]): string[] { safePaths(paths); return ['--pathspec-from-file=-', '--pathspec-file-nul']; }
function safePaths(paths: readonly string[]): string[] {
  if (!paths.length || paths.length > 5000) throw new Error('Select between 1 and 5000 paths.');
  return paths.map(value => {
    if (!value || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes('..')) throw new Error('Invalid relative path.');
    return value;
  });
}
