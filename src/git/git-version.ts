import { execFile } from 'node:child_process';

export interface GitVersion { readonly major: number; readonly minor: number; readonly patch: number; readonly text: string }

/**
 * The oldest Git Pro runs on (June 2021). Below it: 2.30 has no `rev-parse --end-of-options`, which every revision Git Pro passes goes through, so committing,
 * pulling and History fail; 2.31 is the first to report locked and prunable worktrees in `worktree list --porcelain`, which the worktree guards read; 2.32 is the
 * first with `stash show --include-untracked`, which the Stash file list uses.
 */
export const minimumGit = Object.freeze({ major: 2, minor: 32 });
/** `worktree list -z` arrived in 2.36; older Git prints the same records one per line. */
export const worktreeListZ = Object.freeze({ major: 2, minor: 36 });

/** Reads "git version 2.39.5", "git version 2.36.0.windows.1" or "git version 2.39.5 (Apple Git-154)". */
export function parseGitVersion(output: string): GitVersion | undefined {
  const match = /^git version (\d{1,4})\.(\d{1,4})(?:\.(\d{1,4}))?/m.exec(output.trim());
  return match ? Object.freeze({ major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0), text: `${match[1]}.${match[2]}${match[3] === undefined ? '' : `.${match[3]}`}` }) : undefined;
}

export function atLeast(version: GitVersion, floor: { readonly major: number; readonly minor: number }): boolean {
  return version.major > floor.major || (version.major === floor.major && version.minor >= floor.minor);
}

/** Runs `git --version` once. Undefined when the output is not recognized, so an unusual build is not locked out by a guess. */
export function readGitVersion(executable: string, environment: NodeJS.ProcessEnv = process.env): Promise<GitVersion | undefined> {
  return new Promise(resolve => {
    execFile(executable, ['--version'], { timeout: 10_000, windowsHide: true, maxBuffer: 4096, env: { ...environment, LC_ALL: 'C' } },
      (error, stdout) => resolve(error ? undefined : parseGitVersion(String(stdout))));
  });
}
