import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { containsPath } from '../../src/security/paths';

const locate = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' });
export const gitExecutable = locate.stdout.trim().split(/\r?\n/)[0]!;
export async function fixture() {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'git-pro-test-')));
  const root = path.join(parent, 'repository'); await mkdir(root);
  const home = path.join(parent, 'home'); await mkdir(home);
  const config = path.join(home, '.gitconfig');
  await writeFile(config, `[safe]\n\tdirectory = ${root.replace(/\\/g, '/')}\n`);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (args: string[], cwd = root) => {
    const result = spawnSync(gitExecutable, args, { cwd, env, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`Fixture Git failed: ${args[0]} ${result.stderr}`);
    return result.stdout;
  };
  git(['init', '-b', 'main']); git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.autocrlf', 'false']);
  const cleanup = async () => {
    if (!containsPath(await realpath(tmpdir()), parent) || !path.basename(parent).startsWith('git-pro-test-')) throw new Error('Unsafe fixture cleanup.');
    // Windows may retain a process cwd handle briefly after cancellation.
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { parent, root, home, env, git, cleanup };
}
