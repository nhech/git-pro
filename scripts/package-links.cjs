const { spawnSync } = require('node:child_process');

/**
 * Where the packaged README's relative links and images point: the commit the package is built from. The links keep showing what this version showed (not whatever `main`
 * holds later) and start to resolve as soon as the commit is pushed, so the screenshots do not need to ship inside the package.
 */
function packageLinks(cwd) {
  const git = args => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  const head = git(['rev-parse', 'HEAD']), sha = head.status === 0 ? head.stdout.trim() : '';
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('The package links are pinned to a commit: build the package inside the git repository.');
  const remote = git(['branch', '-r', '--contains', sha]);
  if (remote.status === 0 && !remote.stdout.trim()) console.warn(`Warning: ${sha.slice(0, 8)} is not on a remote branch yet. Push it before the package is uploaded, or the README images and links will not load.`);
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty.status === 0 && dirty.stdout.trim()) console.warn('Warning: tracked files have uncommitted changes. The README links point at the last commit, not at these changes.');
  return { sha, baseContentUrl: `https://github.com/nhech/git-pro/blob/${sha}`, baseImagesUrl: `https://raw.githubusercontent.com/nhech/git-pro/${sha}` };
}

module.exports = { packageLinks };
