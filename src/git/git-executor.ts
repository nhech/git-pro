import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { PathPolicy, canonicalFilePath, containsPath, type WorktreeDestinationGrant } from '../security/paths';
import { realpath } from 'node:fs/promises';
import { parseWorktrees } from './tools/tools-parser';
import { boundedFile } from '../utils/bounded-file';
import { historyEdgeInput } from './history/history-builders';
import { buildReadCommand, buildMutationCommand, pathspecInput, type ReadCommand, type MutationCommand } from './command-builders';
import { GitFailure, parseGitError } from './git-error-parser';
import { silentLogger, type Logger } from '../utils/logging';
import { editorCommand, type OwnedEditor, type EditorJob } from './advanced/owned-editor';

type Launcher = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
/** `digest`: stream stdout into a SHA-256 instead of buffering it, so a fingerprint of large output is bounded by time, not memory. */
export interface ReadOptions { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; digest?: boolean }
export interface MutationOptions extends ReadOptions {editorJob?:EditorJob;patchBuffer?:Buffer}
export interface ExecutionDefaults {readTimeoutMs:number;mutationTimeoutMs:number;networkTimeoutMs:number}
export interface ExecutionResult { stdout: Buffer; stderr: Buffer; exitCode: number; durationMs: number; digest?: string }
/** Mutations whose only variable input is a list of paths, passed with --pathspec-from-file. */
type BulkPathMutation = Extract<MutationCommand, { kind: 'stage' | 'unstage' | 'unstageUnborn' | 'discard' | 'acceptConflict' | 'deleteConflict' }>;
const bulkPathKinds: ReadonlySet<string> = new Set(['stage', 'unstage', 'unstageUnborn', 'discard', 'acceptConflict', 'deleteConflict']);
const isBulkPathMutation = (command: MutationCommand): command is BulkPathMutation => bulkPathKinds.has(command.kind);

export function readEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG(?:_|$))/i.test(key)) delete env[key];
  }
  return { ...env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
}

export class GitExecutor {
  private readonly active = new Set<AbortController>();
  private disposed = false;
  constructor(private readonly executable: string, private readonly policy: PathPolicy,
    private readonly logger: Logger = silentLogger, private readonly launch: Launcher = spawn,
    private readonly environment: NodeJS.ProcessEnv = process.env, private readonly editor?: OwnedEditor,
    private readonly defaults:()=>ExecutionDefaults=()=>({readTimeoutMs:15_000,mutationTimeoutMs:120_000,networkTimeoutMs:180_000})) {
    if (!path.isAbsolute(executable) || /\.(?:cmd|bat|ps1)$/i.test(executable)) throw new Error('Git executable must be an absolute native executable path.');
  }
  async read(root: string, command: ReadCommand, options: ReadOptions = {}): Promise<ExecutionResult> {
    const configured=this.defaults(),network=['remoteRef','remoteTagRef','remotePrunePreview'].includes(command.kind);
    const input=command.kind==='historyEdges'?historyEdgeInput(command.edges):undefined;
    return this.run(root, buildReadCommand(command), command.kind,{timeoutMs:network?configured.networkTimeoutMs:configured.readTimeoutMs,...options}, false,false,undefined,input);
  }
  /** Exact approved registered linked tree only; never exposes external mutations. */
  async inspectLinkedWorktree(ownerRoot:string,destination:string,grant:WorktreeDestinationGrant):Promise<{gitDir:string;status:Buffer}>{
    await this.policy.authorizeRoot(ownerRoot);
    const target=await this.policy.authorizeWorktreeDestination(destination,grant);
    const list=parseWorktrees((await this.read(ownerRoot,{kind:'worktrees'})).stdout);
    const canonical=await Promise.all(list.map(item=>canonicalFilePath(item.path)));
    const index=canonical.indexOf(target);
    if(index<=0||list[index]?.bare||list[index]?.locked||list[index]?.prunable)throw new Error('Approved target is not an available registered linked worktree.');
    const options={timeoutMs:this.defaults().readTimeoutMs,maxOutputBytes:5*1024*1024};
    const linked={ownerRoot,grant};
    const ownerCommon=(await this.read(ownerRoot,{kind:'metadata',field:'commonDir'})).stdout.toString('utf8').trim();
    const targetCommon=(await this.run(target,buildReadCommand({kind:'metadata',field:'commonDir'}),'linkedCommonDir',options,false,false,undefined,undefined,linked)).stdout.toString('utf8').trim();
    const common=await realpath(path.resolve(ownerRoot,ownerCommon));
    if(common!==await realpath(path.resolve(target,targetCommon)))throw new Error('Linked worktree no longer shares the registered repository.');
    const gitDir=(await this.run(target,buildReadCommand({kind:'metadata',field:'gitDir'}),'linkedGitDir',options,false,false,undefined,undefined,linked)).stdout.toString('utf8').trim();
    const canonicalGitDir=await realpath(gitDir),linkedMetadata=path.join(common,'worktrees');
    if(canonicalGitDir===linkedMetadata||!containsPath(linkedMetadata,canonicalGitDir))throw new Error('Linked worktree metadata does not belong to its registered owner.');
    const backlink=(await boundedFile(path.join(canonicalGitDir,'gitdir'),65536)).toString('utf8').trim();
    if(!path.isAbsolute(backlink)||await canonicalFilePath(backlink)!==await canonicalFilePath(path.join(target,'.git')))throw new Error('Linked worktree metadata points to a different destination.');
    const status=(await this.run(target,buildReadCommand({kind:'status'}),'linkedStatus',options,false,false,undefined,undefined,linked)).stdout;
    return{gitDir,status};
  }
  async mutate(root: string, command: MutationCommand, options: MutationOptions = {}): Promise<ExecutionResult> {
    if(command.kind==='applyHunk'&&(!options.patchBuffer?.length||options.patchBuffer.length>1024*1024))throw new Error('Owned hunk patch is missing or exceeds 1 MiB.');
    if(options.patchBuffer&&command.kind!=='applyHunk')throw new Error('Patch stdin does not match this mutation.');
    if ('paths' in command && command.paths.length > 5000) throw new Error('Select between 1 and 5000 paths.');
    if ('paths' in command) await this.policy.authorizeFiles(root, command.paths);
    const preserve = command.kind==='operationControl' && command.action==='continue' && command.operation!=='merging';
    if (preserve && !this.editor&&!options.editorJob) throw new Error('Owned message editor unavailable. Continue this operation in native Git.');
    if(command.kind==='interactiveRebase'&&!options.editorJob)throw new Error('Owned sequence editor unavailable.');
    if(options.editorJob&&command.kind!=='interactiveRebase'&&!(command.kind==='operationControl'&&command.operation==='rebasing'))throw new Error('Editor job does not match this operation.');
    const configured=this.defaults(),network=['pushLease','tagPush','tagRemoteDelete','branchPush','remotePrune'].includes(command.kind);
    const limits = { timeoutMs:network?configured.networkTimeoutMs:configured.mutationTimeoutMs,...options };
    // Bulk path mutations read their validated paths from stdin, so a long selection is one process and applies as a whole.
    const input = isBulkPathMutation(command) ? pathspecInput(command.paths) : options.patchBuffer;
    return this.run(root, buildMutationCommand(command), command.kind, limits, true, preserve,options.editorJob,input);
  }
  private async run(root: string, args: string[], label: string, options: ReadOptions, mutation: boolean, preserve = false,job?:EditorJob,input?:Buffer,linked?:{ownerRoot:string;grant:WorktreeDestinationGrant}): Promise<ExecutionResult> {
    if (this.disposed) throw new Error('Git executor is disposed.');
    if(linked){if(mutation)throw new Error('External worktree mutations are not supported by the executor.');await this.policy.authorizeRoot(linked.ownerRoot);}
    const cwd = linked?await this.policy.authorizeWorktreeDestination(root,linked.grant):await this.policy.authorizeRoot(root);
    if (options.signal?.aborted) throw new GitFailure('cancelled', 'Git read cancelled.');
    this.policy.checkTrust();
    if (this.disposed) throw new Error('Git executor is disposed.');
    const controller = new AbortController();
    this.active.add(controller);
    try {
      return await this.execute(cwd, args, label, controller, options, mutation, preserve,job,input);
    } finally { this.active.delete(controller); }
  }
  dispose(): void {
    this.disposed = true;
    for (const controller of this.active) controller.abort();
  }
  private execute(cwd: string, args: string[], label: string, controller: AbortController, options: ReadOptions, mutation: boolean, preserve: boolean,job?:EditorJob,input?:Buffer): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const env = readEnvironment(this.environment);
      if (mutation) { delete env.GIT_OPTIONAL_LOCKS; env.GIT_EDITOR = 'false'; env.GIT_SEQUENCE_EDITOR = 'false'; env.GIT_MERGE_AUTOEDIT = 'no'; }
      if (preserve && this.editor) { env.GIT_EDITOR = editorCommand(this.editor); env.ELECTRON_RUN_AS_NODE = '1'; }
      if(job){env.GIT_EDITOR=editorCommand(job,{file:job.file,token:job.token,mode:'message'});env.GIT_SEQUENCE_EDITOR=editorCommand(job,{file:job.file,token:job.token,mode:'sequence'});env.ELECTRON_RUN_AS_NODE='1';}
      const child = this.launch(this.executable, args, { cwd, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', env, stdio: [input?'pipe':'ignore', 'pipe', 'pipe'] });
      if(input){child.stdin?.on('error',()=>{/* Rejection/cancellation closes stdin; process outcome owns the error. */});child.stdin?.end(input);}
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let bytes = 0, failure: GitFailure | undefined, done = false;
      const stop = (reason: GitFailure) => {
        if (done || failure) return;
        failure = reason;
        // Kill only the tree rooted at the process created by this request.
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, shell: false, stdio: 'ignore' });
          killer.on('error', () => child.kill());
          killer.on('exit', code => { if (code !== 0) child.kill(); });
        } else {
          try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); }
          catch { child.kill('SIGKILL'); }
        }
      };
      const cancelled = () => stop(new GitFailure('cancelled', `Git ${mutation ? 'operation' : 'read'} cancelled; state may have changed. Refresh before retrying.`));
      const timer = setTimeout(() => stop(new GitFailure('timeout', `Git ${mutation ? 'operation' : 'read'} timed out; state may have changed. Refresh before retrying.`)), options.timeoutMs ?? 15_000);
      const consume = (chunks: Buffer[], chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > (options.maxOutputBytes ?? 16 * 1024 * 1024)) stop(new GitFailure('output-limit', 'Git output exceeded the safe limit.'));
        else if (!failure) chunks.push(chunk);
      };
      const hash = options.digest ? createHash('sha256') : undefined;
      child.stdout?.on('data', (chunk: Buffer) => { if (!hash) consume(stdout, chunk); else if (!failure) hash.update(chunk); });
      child.stderr?.on('data', (chunk: Buffer) => consume(stderr, chunk));
      options.signal?.addEventListener('abort', cancelled, { once: true });
      controller.signal.addEventListener('abort', cancelled, { once: true });
      if (options.signal?.aborted || controller.signal.aborted) cancelled();
      child.on('error', error => { failure ??= new GitFailure('unknown', error.message); });
      child.on('close', code => {
        done = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancelled);
        controller.signal.removeEventListener('abort', cancelled);
        const result: ExecutionResult = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code ?? -1, durationMs: Date.now() - started, ...(hash ? { digest: hash.digest('hex') } : {}) };
        // These exact queries use empty exit 1 for no keys/unresolved HEAD. All other
        // failures (including cancellation, limits and config diagnostics) reject.
        const emptyOptionalRead = (label === 'branchUpstreamKeys' || label === 'branchConfig' || label === 'historyHead') && code === 1 && !result.stdout.length && !result.stderr.length;
        failure ??= code === 0 || emptyOptionalRead ? undefined : parseGitError(result.stderr.toString('utf8'), code);
        // Never log stdout, stderr, argv, messages or remote URLs.
        if (failure) { this.logger.error(`${label.toUpperCase()} failed (${failure.kind}) ${result.durationMs}ms`); reject(failure); }
        else {
          // Reads run constantly (status polling, tree views); only changes to the repository are worth an info line.
          const line = `${label.toUpperCase()} completed ${result.durationMs}ms`;
          if (mutation) this.logger.info(line); else this.logger.debug?.(line);
          resolve(result);
        }
      });
    });
  }
}
