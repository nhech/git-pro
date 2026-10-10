import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { PathPolicy } from '../security/paths';

/** Bounded scan; .git may be a directory or linked-worktree/submodule file. */
export async function discoverRepositories(roots: readonly string[], policy: PathPolicy,
  options: { maxDirectories?: number; maxDepth?: number; signal?: AbortSignal } = {}): Promise<string[]> {
  const queue = roots.map(root => ({ root, depth: 0 }));
  const result: string[] = []; const seen = new Set<string>(); let visited = 0;
  const ignored = new Set(['.git', 'node_modules', '.vscode-test', 'dist', '.test-build', '.next']);
  while (queue.length && visited < (options.maxDirectories ?? 200)) {
    if (options.signal?.aborted) break;
    const entry = queue.shift()!;
    const root = await policy.authorizeRoot(entry.root);
    if (seen.has(root)) continue;
    seen.add(root); visited++;
    const children = await readdir(root, { withFileTypes: true });
    if (children.some(child => child.name === '.git' && !child.isSymbolicLink())) result.push(root);
    if (entry.depth < (options.maxDepth ?? 3)) {
      for (const child of children) if (child.isDirectory() && !child.isSymbolicLink() && !ignored.has(child.name)) {
        queue.push({ root: path.join(root, child.name), depth: entry.depth + 1 });
      }
    }
  }
  return result;
}
