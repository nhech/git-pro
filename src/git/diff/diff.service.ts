import { GitService } from '../git.service';
import type { FileChange } from '../git-parser';
import { lstat } from 'node:fs/promises';
export interface DiffContent { left: Buffer; right: Buffer | undefined; title: string; workingPath: string | undefined }
export class DiffService {
  constructor(private readonly git: GitService) {}
  private async content(root: string, oid: string | undefined): Promise<Buffer> {
    if (!oid) return Buffer.alloc(0);
    const size = Number((await this.git.executor.read(root, { kind: 'blobSize', oid })).stdout.toString().trim());
    if (!Number.isFinite(size) || size > 5 * 1024 * 1024) throw new Error('Revision is too large for text diff. Open it in native Source Control.');
    const buffer = (await this.git.executor.read(root, { kind: 'blob', oid }, { maxOutputBytes: 5 * 1024 * 1024 })).stdout;
    if (buffer.includes(0)) throw new Error('Binary revision: open the file through native Source Control.');
    new TextDecoder('utf-8', { fatal: true }).decode(buffer); return buffer;
  }
  /** `known` carries a status the caller just read, so opening one diff costs no extra whole-repository reads. */
  async prepare(id: string, change: FileChange, workingWithHead = false, known?: { head: string | undefined }): Promise<DiffContent> {
    const repo = this.git.repository(id); const head = known ? known.head : (await this.git.state(id)).oid;
    const workingPath = await this.git.authorizePath(id, change.path);
    if ((await lstat(workingPath).catch(() => undefined))?.isSymbolicLink()) throw new Error('Symlink diff: open it in native Source Control.');
    if (change.group === 'conflicts') throw new Error('Open this conflicted file in native Source Control.');
    const tree = async (file: string): Promise<string | undefined> => {
      await this.git.authorizePath(id, file);
      if (!head) return;
      const output = (await this.git.executor.read(repo.root, { kind: 'tree', oid: head, path: file })).stdout.toString('utf8');
      if (output && !/^100(?:644|755) blob /.test(output)) throw new Error('Submodule or symlink diff: open it in native Source Control.');
      return output ? /^\d+ blob ([a-f0-9]+)\t/.exec(output)?.[1] : undefined;
    };
    const index = (await this.git.executor.read(repo.root, { kind: 'index', paths: [change.path] })).stdout.toString('utf8');
    if (index && !/^100(?:644|755) /.test(index)) throw new Error('Submodule or symlink diff: open it in native Source Control.');
    const indexOid = /^\d+ ([a-f0-9]+) 0\t/.exec(index)?.[1];
    const leftOid = change.group === 'staged' || workingWithHead ? await tree(change.originalPath ?? change.path) : indexOid;
    return { left: await this.content(repo.root, leftOid),
      right: change.group === 'staged' ? await this.content(repo.root, indexOid) : change.status === 'D' ? Buffer.alloc(0) : undefined,
      workingPath: change.group === 'staged' || change.status === 'D' ? undefined : workingPath,
      title: `${change.path} (${change.group === 'staged' ? 'HEAD ↔ Index' : workingWithHead ? 'HEAD ↔ Working Tree' : 'Index ↔ Working Tree'})` };
  }
}
