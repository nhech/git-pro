import * as path from 'node:path';
import { realpath, lstat } from 'node:fs/promises';

export interface WorktreeDestinationGrant {readonly destination:string}
/** The path is inside the repository lexically but a symlink or junction on the way resolves outside it. */
export class LinkOutsideError extends Error { constructor() { super('Symlink points outside the repository.'); this.name = 'LinkOutsideError'; } }

export function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Canonicalizes existing parents too, so deleted paths and Windows aliases resolve consistently. */
export async function canonicalFilePath(file: string): Promise<string> {
  let ancestor = path.resolve(file);
  for (;;) {
    try { return path.resolve(await realpath(ancestor), path.relative(ancestor, path.resolve(file))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
      ancestor = path.dirname(ancestor);
    }
  }
}

export class PathPolicy {
  private readonly worktreeGrants=new WeakMap<WorktreeDestinationGrant,{parent:string;dev:number;ino:number}>();
  constructor(private readonly roots: () => readonly string[], private readonly trusted: () => boolean) {}
  checkTrust(): void {
    if (!this.trusted()) throw new Error('Git Pro requires a trusted filesystem workspace.');
  }
  /** Called only after native, explicit approval of this exact destination. */
  async approveWorktreeDestination(destination:string):Promise<WorktreeDestinationGrant>{
    this.checkTrust();
    if(!path.isAbsolute(destination)||destination.includes('\0'))throw new Error('Choose an absolute worktree destination.');
    const resolved=path.resolve(destination),canonical=await canonicalFilePath(resolved);
    if(canonical!==resolved||path.dirname(canonical)===canonical)throw new Error('Choose a canonical non-root destination without aliases or symlinks.');
    const parent=await realpath(path.dirname(canonical)),info=await lstat(parent);
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Worktree parent must be an existing regular directory.');
    this.checkTrust();const grant=Object.freeze({destination:canonical});this.worktreeGrants.set(grant,{parent,dev:info.dev,ino:info.ino});return grant;
  }
  async authorizeWorktreeDestination(destination:string,grant:WorktreeDestinationGrant):Promise<string>{
    this.checkTrust();const captured=this.worktreeGrants.get(grant);
    if(!captured||path.resolve(destination)!==grant.destination||await canonicalFilePath(destination)!==grant.destination)throw new Error('Worktree destination approval expired or does not match.');
    const parent=await realpath(path.dirname(grant.destination)),info=await lstat(parent);
    if(parent!==captured.parent||info.dev!==captured.dev||info.ino!==captured.ino||!info.isDirectory()||info.isSymbolicLink())throw new Error('Approved worktree parent changed. Review the destination again.');
    this.checkTrust();return grant.destination;
  }
  async authorizeRoot(root: string): Promise<string> {
    this.checkTrust();
    const canonical = await realpath(root);
    const approved = await Promise.all(this.roots().map(async folder => realpath(folder)));
    this.checkTrust();
    if (!approved.some(folder => containsPath(folder, canonical))) {
      throw new Error('Repository is outside the workspace. Open its root folder explicitly.');
    }
    return canonical;
  }
  async authorizeFile(root: string, relative: string): Promise<string> {
    return this.authorizeUnder(await this.authorizeRoot(root), relative);
  }
  /** Authorizes the root once for many paths; every path is still checked individually and all must pass. */
  async authorizeFiles(root: string, relatives: readonly string[]): Promise<string[]> {
    const canonicalRoot = await this.authorizeRoot(root), result: string[] = [];
    // Bounded parallelism: thousands of simultaneous filesystem calls would only queue behind the thread pool.
    for (let start = 0; start < relatives.length; start += 64) result.push(...await Promise.all(relatives.slice(start, start + 64).map(relative => this.authorizeUnder(canonicalRoot, relative))));
    return result;
  }
  private async authorizeUnder(canonicalRoot: string, relative: string): Promise<string> {
    if (!relative || relative.includes('\0') || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
      throw new Error('Invalid repository-relative path.');
    }
    const target = path.resolve(canonicalRoot, relative);
    if (!containsPath(canonicalRoot, target)) throw new Error('File is outside the repository.');
    // A removed file is valid; check its nearest existing ancestor before authorizing.
    let ancestor = target;
    for (;;) {
      try {
        await lstat(ancestor);
        const resolved = await realpath(ancestor);
        if (!containsPath(canonicalRoot, resolved)) throw new LinkOutsideError();
        this.checkTrust();
        return target;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }
}
