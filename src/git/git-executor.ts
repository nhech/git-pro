import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { PathPolicy, canonicalFilePath, containsPath, type WorktreeDestinationGrant } from '../security/paths';
import { lstat, realpath, stat } from 'node:fs/promises';
import { parseWorktrees } from './tools/tools-parser';
import { atLeast, parseGitVersion, worktreeListZ, type GitVersion } from './git-version';
import { boundedFile } from '../utils/bounded-file';
import { historyEdgeInput } from './history/history-builders';
import { buildReadCommand, buildMutationCommand, pathspecInput, type ReadCommand, type MutationCommand } from './command-builders';
import { GitFailure, noteStoppedLock, parseGitError, parseMutationError } from './git-error-parser';
import { silentLogger, type Logger } from '../utils/logging';
import { editorCommand, type OwnedEditor, type EditorJob } from './advanced/owned-editor';

type Launcher = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
/** `digest`: stream stdout into a SHA-256 instead of buffering it, so a fingerprint of large output is bounded by time, not memory. */
export interface ReadOptions { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; digest?: boolean }
export interface MutationOptions extends ReadOptions {editorJob?:EditorJob;patchBuffer?:Buffer}
export interface ExecutionDefaults {readTimeoutMs:number;mutationTimeoutMs:number;networkTimeoutMs:number}
export interface ExecutionResult { stdout: Buffer; stderr: Buffer; exitCode: number; durationMs: number; digest?: string }
/** Mutations whose only variable input is a list of paths, passed with --pathspec-from-file. */
type BulkPathMutation = Extract<MutationCommand, { kind: 'stage' | 'unstage' | 'unstageUnborn' | 'discard' | 'acceptConflict' | 'deleteConflict' | 'restoreFromSource' }>;
const bulkPathKinds: ReadonlySet<string> = new Set(['stage', 'unstage', 'unstageUnborn', 'discard', 'acceptConflict', 'deleteConflict', 'restoreFromSource']);
const isBulkPathMutation = (command: MutationCommand): command is BulkPathMutation => bulkPathKinds.has(command.kind);

export function readEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG(?:_|$))/i.test(key)) delete env[key];
  }
  return { ...env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
}
/** How long a stopped POSIX process group has after SIGTERM before SIGKILL. Git removes its lock files on SIGTERM; SIGKILL leaves index.lock behind. */
const killGraceMs = 2_000;
/** The index lock in `root`'s Git directory when it was written after `since`, so by the process Git Pro just stopped (or its hooks). */
async function leftIndexLock(root: string, since: number): Promise<string | undefined> {
  const dotGit = path.join(root, '.git'), info = await lstat(dotGit).catch(() => undefined);
  let gitDir = info?.isDirectory() ? dotGit : undefined;
  // A linked worktree or submodule: `.git` is a file naming its Git directory.
  if (info?.isFile()) { const named = /^gitdir: (.+)$/m.exec((await boundedFile(dotGit, 65536)).toString('utf8'))?.[1]?.trim(); if (named) gitDir = path.resolve(root, named); }
  if (!gitDir) return undefined;
  const file = path.join(gitDir, 'index.lock'), lock = await stat(file).catch(() => undefined);
  // Coarse file system clocks (FAT, some network shares) round modification times down by up to two seconds.
  return lock?.isFile() && lock.mtimeMs >= since - 2_000 ? file : undefined;
}
interface MsysProcess { readonly pid: string; readonly ppid: string; readonly winpid: string }
/** The MSYS2 process table (`ps` long format: PID PPID PGID WINPID …), or nothing when it cannot be read promptly. */
function msysProcesses(bin: string): Promise<MsysProcess[]> {
  return new Promise(resolve => {
    const ps = spawn(path.join(bin, 'ps.exe'), [], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] }), chunks: Buffer[] = [];
    const timer = setTimeout(() => ps.kill(), 2_000);
    ps.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    ps.on('error', () => { clearTimeout(timer); resolve([]); });
    ps.on('close', code => {
      clearTimeout(timer);
      resolve(code !== 0 ? [] : Buffer.concat(chunks).toString('latin1').split(/\r?\n/).flatMap(line => {
        const match = /^\D*(\d+)\s+(\d+)\s+\d+\s+(\d+)\s/.exec(line);
        return match ? [{ pid: match[1]!, ppid: match[2]!, winpid: match[3]! }] : [];
      }));
    });
  });
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
    // `worktree list -z` needs Git 2.36; older Git prints the same records newline-separated, which parseWorktrees reads too.
    const args=command.kind==='worktrees'&&!await this.supportsWorktreeZ(root)?buildReadCommand(command).filter(argument=>argument!=='-z'):buildReadCommand(command);
    return this.run(root, args, command.kind,{timeoutMs:network?configured.networkTimeoutMs:configured.readTimeoutMs,...options}, false,false,undefined,input);
  }
  private knownVersion: GitVersion | undefined;
  /** Unknown versions count as modern: a failed `--version` must not turn a working Git into the legacy form. */
  private async supportsWorktreeZ(root: string): Promise<boolean> {
    this.knownVersion ??= await this.read(root, { kind: 'version' }, { timeoutMs: 10_000 }).then(result => parseGitVersion(result.stdout.toString('utf8')), () => undefined);
    return this.knownVersion === undefined || atLeast(this.knownVersion, worktreeListZ);
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
  private msysBin: Promise<string | undefined> | undefined;
  /**
   * `taskkill /T /F` on the tree of the Git process one request started. Git for Windows runs hooks under MSYS2, whose exec starts the new program from a
   * stub that then exits, so a hook's `sleep` is outside that Windows tree. MSYS still records its parent: descendants taskkill missed are killed by MSYS PID.
   */
  private killWindowsTree(child: ChildProcess, pid: number): void {
    // Git for Windows: <root>\cmd\git.exe, <root>\bin\git.exe or <root>\mingw64\bin\git.exe beside <root>\usr\bin. MinGit has no MSYS tools.
    this.msysBin ??= (async () => {
      for (const bin of [path.resolve(path.dirname(this.executable), '..', 'usr', 'bin'), path.resolve(path.dirname(this.executable), '..', '..', 'usr', 'bin')])
        if ((await Promise.all(['ps.exe', 'kill.exe'].map(name => stat(path.join(bin, name)).then(info => info.isFile(), () => false)))).every(Boolean)) return bin;
      return undefined;
    })();
    // The MSYS table is read first: once taskkill stops the hook's shell, nothing links its orphaned children to this request.
    this.msysBin.then(async bin => ({ bin, before: bin ? await msysProcesses(bin) : [] })).then(({ bin, before }) => {
      const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/pid', String(pid), '/t', '/f'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      killer.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('latin1'); });
      killer.on('error', () => child.kill());
      killer.on('close', code => {
        if (code !== 0) child.kill();
        // Every PID taskkill reports belongs to the stopped tree, except this process as the parent of its root.
        const tree = new Set((output.match(/\d+/g) ?? []).filter(id => id !== String(process.pid)));
        const owned = new Set(before.filter(row => tree.has(row.winpid)).map(row => row.pid));
        for (let grown = owned.size > 0; grown;) { grown = false; for (const row of before) if (!owned.has(row.pid) && owned.has(row.ppid)) { owned.add(row.pid); grown = true; } }
        const missed = before.filter(row => owned.has(row.pid) && !tree.has(row.winpid)).map(row => row.pid);
        if (bin && missed.length) spawn(path.join(bin, 'kill.exe'), ['-KILL', ...missed], { windowsHide: true, shell: false, stdio: 'ignore' }).on('error', () => { /* Best effort: the Windows tree is stopped. */ });
      });
    }).catch(() => child.kill());
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
      let bytes = 0, failure: GitFailure | undefined, done = false, killed = false;
      const stop = (reason: GitFailure) => {
        if (done || failure) return;
        failure = reason;
        const pid = child.pid;
        if (!pid) return;
        killed = true;
        // Kill only the tree rooted at the process created by this request.
        if (process.platform === 'win32') this.killWindowsTree(child, pid);
        else {
          const signal = (name: NodeJS.Signals) => { try { process.kill(-pid, name); } catch { child.kill(name); } };
          // SIGTERM first: Git removes its lock files, and the hooks in its process group stop too. Whatever still runs after the grace period is killed.
          signal('SIGTERM'); setTimeout(() => signal('SIGKILL'), killGraceMs).unref();
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
        // These exact queries use empty exit 1 for no keys/unresolved HEAD/unrelated histories. All other
        // failures (including cancellation, limits and config diagnostics) reject.
        const emptyOptionalRead = (label === 'branchUpstreamKeys' || label === 'branchConfig' || label === 'historyHead' || label === 'mergeBase') && code === 1 && !result.stdout.length && !result.stderr.length;
        failure ??= code === 0 || emptyOptionalRead ? undefined : mutation ? parseMutationError(label, result.stdout, result.stderr.toString('utf8'), code) : parseGitError(result.stderr.toString('utf8'), code);
        // Never log stdout, stderr, argv, messages or remote URLs.
        if (failure) {
          this.logger.error(`${label.toUpperCase()} failed (${failure.kind}) ${result.durationMs}ms`);
          if (!killed || !mutation) { reject(failure); return; }
          // A stopped mutation can leave the index lock behind (Windows can only force-kill). Name it, so neither this error nor the next action's
          // "Unable to create index.lock" reads as another Git operation.
          const stopped = failure;
          void leftIndexLock(cwd, started).then(file => {
            if (!file) return stopped;
            noteStoppedLock(file);
            return new GitFailure(stopped.kind, `${stopped.message}\nGit Pro stopped the Git process, which left ${file}.`, stopped.exitCode, stopped.partial, file);
          }, () => stopped).then(reject);
        } else {
          // Reads run constantly (status polling, tree views); only changes to the repository are worth an info line.
          const line = `${label.toUpperCase()} completed ${result.durationMs}ms`;
          if (mutation) this.logger.info(line); else this.logger.debug?.(line);
          resolve(result);
        }
      });
    });
  }
}
