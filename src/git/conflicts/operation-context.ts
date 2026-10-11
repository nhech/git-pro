import { lstat } from 'node:fs/promises';
import * as path from 'node:path';
import type { AdvancedService } from '../advanced/advanced.service';
import { parseStatus, type StatusSnapshot } from '../git-parser';
import { GitFailure } from '../git-error-parser';
import { decode, parseHistory } from '../history/history-parser';
import { detectConflictOperation, rebasePaused, type GitOperation } from '../../state/operation-state';
import { boundedFile } from '../../utils/bounded-file';
import { validateBranchName, validateOid } from '../../security/refs';
import { redact } from '../../security/redaction';
import type { RepositoryDescriptor } from '../../repositories/repository-registry';
import { sidesFor } from './conflict-kinds';
import type { ConflictSource, OperationSide, OperationSummary, OperationSummaryProvider } from './conflict-contract';

/** The label Git writes on the stash side of a `stash apply`/`pop` conflict, the same evidence built-in Git uses. */
export const stashLabel = /^>{7} Stashed changes\r?$/m;
const controllable: readonly GitOperation[] = ['merging', 'rebasing', 'cherry-picking', 'reverting'];
/** N6: operation metadata is repository-controlled. Bounded, never through a link, strict UTF-8; anything unreadable or malformed only drops that label. */
async function metadata(gitDir: string, name: string, maximum = 4096): Promise<string | undefined> {
  try { return decode(await boundedFile(path.join(gitDir, name), maximum)); } catch { return undefined; }
}
async function oidFile(gitDir: string, name: string): Promise<string | undefined> {
  const value = (await metadata(gitDir, name))?.split(/\r?\n/)[0]?.trim();
  try { return value ? validateOid(value) : undefined; } catch { return undefined; }
}
async function counter(gitDir: string, name: string): Promise<number | undefined> {
  const value = (await metadata(gitDir, name, 64))?.trim();
  return value && /^\d{1,7}$/.test(value) ? Number(value) : undefined;
}
/** `head-name` is the literal `detached HEAD` or one `refs/heads/` line naming a valid branch; anything else is not shown. */
function headName(value: string | undefined): string | undefined {
  const name = value?.replace(/\r?\n$/, '');
  if (name === 'detached HEAD') return name;
  if (!name?.startsWith('refs/heads/')) return;
  try { return validateBranchName(name.slice(11)); } catch { return; }
}
function refLabel(ref: string): string | undefined {
  const match = /^refs\/(heads|remotes|tags)\/(.+)$/.exec(ref);
  if (!match || match[1] === 'remotes' && match[2]!.endsWith('/HEAD')) return;
  try { return validateBranchName(match[2]!); } catch { return; }
}
const short = (oid: string) => oid.slice(0, 7);
/** Both rebase backends (§3.4): rebase-merge has msgnum/end, rebase-apply has next/last. */
const rebaseDir = async (gitDir: string) => (await lstat(path.join(gitDir, 'rebase-merge')).catch(() => undefined))?.isDirectory() === true ? 'rebase-merge' : 'rebase-apply';
function side(label: 'Yours' | 'Theirs', detail: string, ref?: string, oid?: string, subject?: string): OperationSide {
  return Object.freeze({ label, ...(ref ? { ref: redact(ref) } : {}), ...(oid ? { oid } : {}), ...(subject ? { subject: redact(subject) } : {}), detail: redact(detail) });
}
/** Git's prepared merge message for Edit Message…: bounded strict UTF-8 with its comment lines (the `# Conflicts:` block) removed. Empty when Git left none or it cannot be read; the user reviews it either way. */
export async function readMergeMessage(gitDir: string): Promise<string> {
  const text = await metadata(gitDir, 'MERGE_MSG', 256 * 1024);
  const kept = (text ?? '').split(/\r?\n/).filter(line => !line.startsWith('#')).join('\n').replace(/\s+$/, '');
  return kept ? `${kept.slice(0, 65535)}\n` : '';
}
/** WP1's operation context (§3.4): titles, Yours/Theirs labels and progress for the banner, the Conflicts tab and the merge editor. Display only; it never mutates. */
export class OperationContext implements OperationSummaryProvider {
  constructor(private readonly advanced: AdvancedService, private readonly sources: ReadonlyMap<string, ConflictSource> = new Map()) {}
  /** One status read and the operation markers; no fingerprint, so a banner refresh stays cheap. */
  async summary(repositoryId: string, signal?: AbortSignal): Promise<OperationSummary> {
    const repo = this.advanced.git.repository(repositoryId), options = signal ? { signal } : {};
    const status = parseStatus((await this.advanced.git.executor.read(repo.root, { kind: 'status' }, options)).stdout), operation = await detectConflictOperation(repo.gitDir, () => status.changes.some(change => change.group === 'conflicts'));
    const summary = await this.describe(repo, operation, status, {}, signal);
    if (this.advanced.git.repository(repositoryId) !== repo) throw new Error('Repository changed while reading the operation.');
    return summary;
  }
  /** `stashMarkers` is known when the caller already read the conflicted files; otherwise the first few are checked. */
  async describe(repo: RepositoryDescriptor, operation: GitOperation, status: StatusSnapshot, hints: { readonly stashMarkers?: boolean } = {}, signal?: AbortSignal): Promise<OperationSummary> {
    const cancelled = () => { if (signal?.aborted) throw new GitFailure('cancelled', 'Operation summary cancelled.'); };
    cancelled();
    const sides = sidesFor(operation), gitDir = repo.gitDir, conflicts = status.changes.filter(change => change.group === 'conflicts').length;
    // A cherry-pick, revert, merge or stash apply run at a rebase stop owns these conflicts (detectConflictOperation); HEAD is then detached on the rebased work.
    const paused = operation !== 'rebasing' && await rebasePaused(gitDir), rebased = paused ? headName(await metadata(gitDir, `${await rebaseDir(gitDir)}/head-name`)) : undefined;
    const branch = status.head && status.head !== '(detached)' ? status.head : undefined, head = status.oid;
    const here = paused ? `${rebased ?? 'detached HEAD'} (rebase paused)` : branch ?? 'detached HEAD';
    let title: string, yours = side('Yours', here, branch, head), theirs = side('Theirs', 'Other side');
    let progress: { current: number; total: number } | undefined, source: OperationSummary['source'];
    if (operation === 'merging') {
      const other = await oidFile(gitDir, 'MERGE_HEAD'), refs = await this.refs(repo, other, signal), name = refs[0] ?? (other ? short(other) : 'another commit');
      title = `Merging ${name} into ${here}`; theirs = side('Theirs', refs.join(', ') || name, refs[0], other, await this.subject(repo, other, signal));
    } else if (operation === 'rebasing') {
      // REBASE_HEAD is the commit being replayed in either backend.
      const dir = await rebaseDir(gitDir), merge = dir === 'rebase-merge';
      const original = headName(await metadata(gitDir, `${dir}/head-name`)), onto = await oidFile(gitDir, `${dir}/onto`), replayed = await oidFile(gitDir, 'REBASE_HEAD');
      const ontoRefs = await this.refs(repo, onto, signal), ontoName = ontoRefs[0] ?? (onto ? short(onto) : 'the upstream');
      const current = await counter(gitDir, `${dir}/${merge ? 'msgnum' : 'next'}`), total = await counter(gitDir, `${dir}/${merge ? 'end' : 'last'}`);
      if (current && total && current <= total) progress = { current, total };
      const rebasedBranch = original && original !== 'detached HEAD' ? original : undefined;
      title = `Rebasing ${original ?? 'commits'} onto ${ontoName}`;
      // WebStorm's rebase wording (§2.2): Yours is the replayed commit (Git --theirs), Theirs the upstream plus what is already replayed (Git --ours, HEAD).
      yours = side('Yours', replayed ? `Rebasing ${short(replayed)} from ${original ?? 'the original branch'}` : `Commit being rebased from ${original ?? 'the original branch'}`, rebasedBranch, replayed, await this.subject(repo, replayed, signal));
      theirs = side('Theirs', `Already rebased commits and commits from ${ontoName}`, ontoRefs[0], head);
    } else if (operation === 'cherry-picking' || operation === 'reverting') {
      const picking = operation === 'cherry-picking', commit = await oidFile(gitDir, picking ? 'CHERRY_PICK_HEAD' : 'REVERT_HEAD'), refs = await this.refs(repo, commit, signal);
      const name = commit ? short(commit) : 'commits';
      title = picking ? `Cherry-picking ${name} onto ${here}` : `Reverting ${name} on ${here}`;
      theirs = side('Theirs', picking ? refs.join(', ') || `Commit ${name}` : `Before ${name} (the reverted commit)`, refs[0], commit, await this.subject(repo, commit, signal));
    } else if (operation === 'idle') {
      const recorded = conflicts ? this.sources.get(repo.id) : undefined;
      if (recorded?.kind === 'squash') {
        const refs = await this.refs(repo, recorded.oid, signal), name = refs[0] ?? short(recorded.oid);
        title = `Squash-merging ${name}`; theirs = side('Theirs', refs.join(', ') || name, refs[0], recorded.oid, await this.subject(repo, recorded.oid, signal)); source = recorded;
      } else if (recorded) {
        title = `Conflicts from applying ${recorded.selector} (stash kept)`; theirs = side('Theirs', `${recorded.selector} · Stashed changes`, recorded.selector, recorded.oid); source = recorded;
      } else if (conflicts && (hints.stashMarkers ?? await this.stashMarkers(repo, status))) {
        title = 'Conflicts from applying a stash (stash kept)'; theirs = side('Theirs', 'Stashed changes'); source = Object.freeze({ kind: 'stashMarkers' as const });
      } else title = conflicts ? 'Unresolved conflicts' : 'No merge conflicts';
      if (paused) title += ` · rebase of ${rebased ?? 'detached HEAD'} paused`;
    } else title = operation === 'bisecting' ? 'Bisect in progress — finish in native Git' : operation === 'applying-mail' ? 'git am in progress — finish in native Git' : 'A Git sequence is in progress — finish in native Git';
    cancelled();
    const control = controllable.includes(operation), editStop = await this.advanced.isEditStop({ repositoryId: repo.id, operation, status });
    return Object.freeze({ repositoryId: repo.id, operation, ...(head ? { head } : {}), title: redact(title), yours, theirs, sides, ...(progress ? { progress: Object.freeze(progress) } : {}), ...(source ? { source } : {}),
      conflicts, editStop, canContinue: control && !conflicts, canSkip: control && operation !== 'merging', canAbort: control, nativeOnly: !control && operation !== 'idle' });
  }
  /** Branches, then remote branches, then tags at this commit (at most 4, Git's refname order); empty when none or unreadable. */
  private async refs(repo: RepositoryDescriptor, oid: string | undefined, signal?: AbortSignal): Promise<string[]> {
    if (!oid) return [];
    try { return decode((await this.advanced.git.executor.read(repo.root, { kind: 'pointsAt', oid }, { maxOutputBytes: 64 * 1024, ...(signal ? { signal } : {}) })).stdout).split('\n').map(line => refLabel(line.replace(/\0$/, ''))).filter((name): name is string => !!name); }
    catch (error) { if (error instanceof GitFailure && error.kind === 'cancelled') throw error; return []; }
  }
  private async subject(repo: RepositoryDescriptor, oid: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
    if (!oid) return;
    try { return parseHistory((await this.advanced.git.executor.read(repo.root, { kind: 'commitMetadata', oid }, { maxOutputBytes: 64 * 1024, ...(signal ? { signal } : {}) })).stdout)[0]?.subject.slice(0, 200); }
    catch (error) { if (error instanceof GitFailure && error.kind === 'cancelled') throw error; return; }
  }
  /** Idle conflicts with no record: a terminal `stash apply`/`pop` leaves only its marker label, so the first few conflicted files are checked (1 MiB each). */
  private async stashMarkers(repo: RepositoryDescriptor, status: StatusSnapshot): Promise<boolean> {
    for (const change of status.changes.filter(item => item.group === 'conflicts').slice(0, 8)) {
      try { if (stashLabel.test((await boundedFile(await this.advanced.git.authorizePath(repo.id, change.path), 1024 * 1024)).toString('latin1'))) return true; }
      catch { /* An unreadable file is no evidence either way. */ }
    }
    return false;
  }
}
