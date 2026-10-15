import { GitService } from '../../src/git/git.service';
import type { DailyBackend } from '../../src/git/daily-backend';
import { GitExecutor } from '../../src/git/git-executor';
import { PathPolicy } from '../../src/security/paths';
import { RepositoryRegistry } from '../../src/repositories/repository-registry';
import { RepositoryStore } from '../../src/state/repository-store';
import { OperationCoordinator } from '../../src/state/operation-coordinator';
import { Emitter } from '../../src/utils/events';
import { silentLogger } from '../../src/utils/logging';
import { fixture, gitExecutable } from './repository-fixture';

/** A real repository with the owned services over it; the backend runs plain Git so no VS Code is needed. */
export async function dailyFixture() {
  const f = await fixture(); const event = new Emitter<void>();
  const policy = new PathPolicy(() => [f.parent], () => true);
  const executor = new GitExecutor(gitExecutable, policy, silentLogger, undefined, f.env);
  const store = new RepositoryStore(); const registry = new RepositoryRegistry(policy, executor, store, silentLogger, 60_000);
  const coordinator = new OperationCoordinator(() => policy.checkTrust());
  const backend: DailyBackend = {
    stage: async (root, files) => { f.git(['--literal-pathspecs', 'add', '--', ...files], root); },
    commit: async (root, message, opts) => { f.git(['commit', '-m', message, ...(opts.amend ? ['--amend'] : []), ...(opts.signoff ? ['--signoff'] : []), ...(opts.noVerify ? ['--no-verify'] : [])], root); },
    fetch: async (root, remote) => { f.git(['fetch', remote ?? 'origin'], root); },
    push: async (root, remote, branch, upstream) => { f.git(['push', ...(upstream ? ['--set-upstream'] : []), remote, branch], root); },
    createBranch: async (root, name, checkout, base) => { f.git(checkout ? ['checkout', '-b', name, ...(base ? [base] : [])] : ['branch', name, ...(base ? [base] : [])], root); },
    checkout: async (root, name) => { f.git(['checkout', name], root); },
    deleteBranch: async (root, name, force) => { f.git(['branch', force ? '-D' : '-d', name], root); },
    setUpstream: async (root, name, upstream) => { f.git(['branch', `--set-upstream-to=${upstream}`, name], root); },
    remotes: async root => f.git(['remote'], root).trim().split(/\r?\n/).filter(Boolean).map(name => ({ name, fetchUrl: f.git(['remote', 'get-url', name], root).trim() }))
  };
  await registry.sync([{ root: f.root, onDidChange: event.event }]);
  const git = new GitService(registry, executor, policy, coordinator, backend); const id = registry.active!.id;
  const close = async () => { coordinator.dispose(); registry.dispose(); executor.dispose(); store.dispose(); event.dispose(); await f.cleanup(); };
  return { ...f, rawGit: f.git, git, id, backend, close };
}
export const options = { amend: false, signoff: false, noVerify: false };
