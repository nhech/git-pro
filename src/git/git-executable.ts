import * as path from 'node:path';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { containsPath } from '../security/paths';

const unavailable = () => new Error('Git executable is unavailable or unsafe. Configure an absolute native Git path in VS Code, then reload.');

/** Resolve the public Git API's bare name without allowing repository/PATH shell fallback. */
export async function resolveGitExecutable(reported: string, workspaceRoots: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (!reported || reported.length > 32768 || /[\0\r\n]/.test(reported) || /\.(?:cmd|bat|ps1)$/i.test(reported)) throw unavailable();
  const nativeFile = async (candidate: string): Promise<string | undefined> => {
    try {
      const canonical = await realpath(candidate);
      if (/\.(?:cmd|bat|ps1)$/i.test(canonical) || !(await stat(canonical)).isFile()) return;
      await access(canonical, constants.X_OK);
      return canonical;
    } catch { return; }
  };
  if (path.isAbsolute(reported)) {
    const configured = await nativeFile(reported);
    if (!configured) throw unavailable();
    return configured;
  }
  if (reported !== 'git' && !(process.platform === 'win32' && reported.toLowerCase() === 'git.exe')) throw unavailable();
  const value = environment.PATH ?? environment.Path ?? environment.path;
  if (!value || value.length > 65536 || /[\0\r\n]/.test(value)) throw unavailable();
  const directories = value.split(path.delimiter);
  if (directories.length > 256 || directories.some(directory => !path.isAbsolute(directory))) throw unavailable();
  const roots = (await Promise.all(workspaceRoots.map(async root => [path.resolve(root), await realpath(root)]))).flat();
  for (const directory of directories) {
    const located = path.join(directory, process.platform === 'win32' ? 'git.exe' : 'git');
    const candidate = await nativeFile(located);
    if (!candidate) continue;
    const canonicalDirectory = await realpath(directory);
    if (roots.some(root => containsPath(root, located) || containsPath(root, canonicalDirectory) || containsPath(root, candidate))) throw unavailable();
    return candidate;
  }
  throw unavailable();
}
