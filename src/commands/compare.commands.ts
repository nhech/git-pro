import * as vscode from 'vscode';
import * as path from 'node:path';
import { lstat } from 'node:fs/promises';
import type { FeatureDeps, TrustedCommand } from '../conflicts/surfaces';
import type { CompareSurface } from '../webviews/compare/compare-contract';
import { createCompareSurface } from '../webviews/compare/compare-panel';
import type { BranchNode } from '../views/branches/branches.provider';
import type { AdvancedPreview } from '../git/advanced/advanced.service';
import { decode } from '../git/history/history-parser';
import { canonicalFilePath } from '../security/paths';
import { redact } from '../security/redaction';
import { branchVisual } from '../views/tree-visuals';
import { getFromBranch } from './get-from-branch';

export type BranchEntry = Extract<BranchNode, { kind: 'branch' }>;
type CompareDeps = Pick<FeatureDeps, 'registry' | 'policy' | 'executor' | 'git' | 'advanced' | 'tools' | 'history' | 'revisions'>;
interface RefChoice { readonly ref: string; readonly name: string; readonly kind: 'local' | 'remote' | 'tag'; readonly current: boolean }

/** A Branches view node as VS Code hands it back to a command: only its shape is trusted, and its repository must still be open. */
export function branchEntry(deps: Pick<FeatureDeps, 'registry'>, value: unknown): BranchEntry | undefined {
  const node = value && typeof value === 'object' ? value as { kind?: unknown; repositoryId?: unknown; branch?: unknown } : undefined;
  const branch = node?.branch && typeof node.branch === 'object' ? node.branch as Record<string, unknown> : undefined;
  if (node?.kind !== 'branch' || typeof node.repositoryId !== 'string' || !branch || typeof branch.name !== 'string' || typeof branch.oid !== 'string' || typeof branch.remote !== 'boolean'
    || branch.ref !== `refs/${branch.remote ? 'remotes' : 'heads'}/${branch.name}`) return undefined;
  if (!deps.registry.list().some(repo => repo.id === node.repositoryId)) throw new Error('Repository is no longer open.');
  return value as BranchEntry;
}
/** The checked-out branch as a full ref, so a tag of the same name never shadows it; `HEAD` when detached. */
export function currentRef(deps: Pick<FeatureDeps, 'registry'>, id: string): { ref: string; name: string } {
  const head = deps.registry.store.get(id)?.head;
  return head && head !== '(detached)' ? { ref: `refs/heads/${head}`, name: head } : { ref: 'HEAD', name: 'HEAD' };
}
const isCurrent = (deps: Pick<FeatureDeps, 'registry'>, entry: BranchEntry) => !entry.branch.remote && entry.branch.name === deps.registry.store.get(entry.repositoryId)?.head;
function activeId(deps: Pick<FeatureDeps, 'registry'>): string { const id = deps.registry.active?.id; if (!id) throw new Error('Select a repository first.'); return id; }

/** Branches first (the current one on top when it is offered), then up to 500 tags; the same sources as History refs. */
async function pickRef(deps: CompareDeps, id: string, title: string, includeCurrent: boolean, exclude?: string): Promise<RefChoice | undefined> {
  const [branches, tags] = await Promise.all([deps.git.branchSearchSnapshot(id), deps.tools.tags(id)]);
  if (branches.length > 10000) throw new Error('More than 10000 branches. Enter exact refs in History & Compare.');
  const head = deps.registry.store.get(id)?.head;
  const choices: RefChoice[] = [...branches.map(branch => ({ ref: branch.ref, name: branch.name, kind: branch.remote ? 'remote' as const : 'local' as const, current: !branch.remote && branch.name === head })),
    ...tags.slice(0, 500).map(tag => ({ ref: `refs/tags/${tag.name}`, name: tag.name, kind: 'tag' as const, current: false }))]
    .filter(choice => (includeCurrent || !choice.current) && choice.ref !== exclude).sort((a, b) => Number(b.current) - Number(a.current));
  if (!choices.length) throw new Error(includeCurrent && !exclude ? 'This repository has no branches or tags yet.' : 'There is no other branch or tag to compare with.');
  const items = choices.map(choice => {
    const visual = choice.kind === 'tag' ? undefined : branchVisual({ remote: choice.kind === 'remote', current: choice.current });
    return { label: redact(choice.name), description: choice.current ? 'Current branch' : choice.kind === 'remote' ? 'Remote branch' : choice.kind === 'tag' ? 'Tag' : 'Local branch',
      iconPath: visual ? new vscode.ThemeIcon(visual.icon, new vscode.ThemeColor(visual.color)) : new vscode.ThemeIcon('tag'), choice };
  });
  const picked = await vscode.window.showQuickPick(items, { title, matchOnDescription: true, placeHolder: tags.length > 500 ? 'Branches and the first 500 tags' : 'Branches and tags' });
  if (picked && !deps.registry.list().some(repo => repo.id === id)) throw new Error('Repository is no longer open.');
  return picked?.choice;
}

/** Same review text as Advanced Actions (advanced.commands.ts), with the branch named beside its pinned OID. */
export function integrationDetail(deps: Pick<FeatureDeps, 'git'>, preview: AdvancedPreview, target: string): string {
  const local = preview.snapshot.status.changes.map(change => `${change.group}: ${change.path}`);
  const rebase = preview.rebaseContext ? `\nLocal-only commits: ${preview.rebaseContext.localCount} · first ${preview.rebaseContext.candidates.length} shown\n${preview.rebaseContext.candidates.map(commit => `${commit.oid.slice(0, 10)} ${commit.subject.slice(0, 200)}`).join('\n')}\nTopology context: Git may flatten merges or skip equivalent commits.` : '';
  const merge = preview.mergeContext ? `\nTopology: ${preview.mergeContext.headOnly} HEAD-only / ${preview.mergeContext.targetOnly} target-only commits\nResulting history depends on the selected merge strategy.` : '';
  return redact(`${deps.git.repository(preview.snapshot.repositoryId).root}\nHEAD: ${preview.snapshot.head}\nTarget: ${target}\n${preview.files.length} changed files between HEAD and target\n${preview.files.slice(0, 20).map(file => file.path).join('\n')}\nLocal changes: ${local.length}\n${local.slice(0, 20).join('\n')}${rebase}${merge}`);
}

/** Compare entry points (§3.7–§3.9) and Merge into Current / Rebase Current onto This (owner decision Q3), all behind the trusted wrapper. */
export class CompareCommands {
  constructor(private readonly deps: CompareDeps, private readonly surface: CompareSurface) {}
  async compareWithCurrent(value: unknown): Promise<void> {
    const entry = branchEntry(this.deps, value);
    if (entry) {
      if (isCurrent(this.deps, entry)) throw new Error(`${redact(entry.branch.name)} is the current branch. Choose another branch to compare with.`);
      await this.surface.openRefs(entry.repositoryId, entry.branch.ref, currentRef(this.deps, entry.repositoryId).ref); return;
    }
    const id = activeId(this.deps), choice = await pickRef(this.deps, id, `Compare with Current (${redact(currentRef(this.deps, id).name)})`, false);
    if (choice) await this.surface.openRefs(id, choice.ref, currentRef(this.deps, id).ref);
  }
  async diffWithWorkingTree(value: unknown): Promise<void> {
    const entry = branchEntry(this.deps, value);
    if (entry) { await this.surface.openWorktree(entry.repositoryId, entry.branch.ref); return; }
    const id = activeId(this.deps), choice = await pickRef(this.deps, id, 'Show Diff with Working Tree', false);
    if (choice) await this.surface.openWorktree(id, choice.ref);
  }
  /** Exactly two branches of one repository (`listDoubleSelection`); a checked-out one reads on the right, as Compare with Current shows it. */
  async compareBranches(value: unknown, selected: unknown): Promise<void> {
    const nodes = (Array.isArray(selected) ? selected as unknown[] : [value]).map(item => branchEntry(this.deps, item));
    if (nodes.length !== 2 || !nodes[0] || !nodes[1]) throw new Error('Select exactly two branches to compare.');
    let [left, right] = [nodes[0], nodes[1]];
    if (left.repositoryId !== right.repositoryId) throw new Error('Select two branches from one repository.');
    if (left.branch.ref === right.branch.ref) throw new Error('Select two different branches to compare.');
    if (isCurrent(this.deps, left)) [left, right] = [right, left];
    await this.surface.openRefs(left.repositoryId, left.branch.ref, right.branch.ref);
  }
  /**
   * Any branch against a branch or tag picked from a list, like WebStorm's "Compare with…", so the checked-out branch and remote branches can be compared too.
   * From the palette both sides are picked. The checked-out branch reads on the right, as in Compare Branches.
   */
  async compareWithAnother(value: unknown): Promise<void> {
    const entry = branchEntry(this.deps, value), id = entry ? entry.repositoryId : activeId(this.deps);
    const first: RefChoice | undefined = entry ? { ref: entry.branch.ref, name: entry.branch.name, kind: entry.branch.remote ? 'remote' : 'local', current: isCurrent(this.deps, entry) }
      : await pickRef(this.deps, id, 'Compare: choose the first branch or tag', true);
    if (!first) return;
    const second = await pickRef(this.deps, id, `Compare ${redact(first.name)} with…`, true, first.ref);
    if (!second) return;
    const [left, right] = first.current ? [second, first] : [first, second];
    await this.surface.openRefs(id, left.ref, right.ref);
  }
  /** §3.9: the ref's bounded blob as a read-only snapshot on the left, the real file (editable) on the right. */
  async compareWithRef(value: unknown): Promise<void> {
    const target = value instanceof vscode.Uri ? value : vscode.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== 'file') throw new Error('Open a file in a repository.');
    const repo = await this.deps.registry.resolveFile(target.fsPath); if (!repo) throw new Error('File is outside an open repository.');
    const relative = path.relative(repo.root, await canonicalFilePath(target.fsPath)).replace(/\\/g, '/'), absolute = await this.deps.policy.authorizeFile(repo.root, relative);
    if ((await lstat(absolute).catch(() => undefined))?.isDirectory()) throw new Error('Choose a file. Comparing folders with a branch or tag is not available yet.');
    const file = path.basename(relative), choice = await pickRef(this.deps, repo.id, `Compare ${redact(file)} with Branch or Tag`, true); if (!choice) return;
    const oid = await this.deps.advanced.resolve(repo.id, choice.ref);
    if (!decode((await this.deps.executor.read(repo.root, { kind: 'tree', oid, path: relative }, { maxOutputBytes: 64 * 1024 })).stdout)) {
      await vscode.window.showInformationMessage(redact(`${file} does not exist in ${choice.name}.`)); return;
    }
    const left = this.deps.revisions.add(await this.deps.history.revision(repo.id, oid, relative), relative);
    await vscode.commands.executeCommand('vscode.diff', left, target, redact(`${file} (${choice.name} ${oid.slice(0, 8)}) ↔ Working Tree`));
  }
  /**
   * Pins the branch the user saw: a branch that moved since the list was read is refused, as Branch Actions refuses a changed branch. The preview, modal detail
   * and execute path are Advanced Actions'; a merge that stops on conflicts rejects into the trusted wrapper, which opens Conflicts.
   */
  async integrate(value: unknown, kind: 'merge' | 'rebase'): Promise<void> {
    const entry = branchEntry(this.deps, value); if (!entry) throw new Error('Choose a branch in the Branches view or Branch Actions.');
    const { repositoryId: id, branch } = entry;
    if (isCurrent(this.deps, entry)) throw new Error(`${redact(branch.name)} is the current branch. Choose another branch.`);
    const oid = await this.deps.advanced.resolve(id, branch.ref);
    if (oid !== branch.oid) throw new Error('Branch changed. Reopen Branch Actions before continuing.');
    // The merge runs on the pinned OID; `source` makes the message say "Merge branch 'feature'" instead of "Merge commit '<oid>'".
    const preview = await this.deps.advanced.preview(id, kind === 'merge' ? { kind: 'merge', oid, strategy: 'ff', source: branch.ref } : { kind: 'rebase', oid });
    const head = preview.snapshot.status.head, current = head && head !== '(detached)' ? head : 'detached HEAD';
    const title = kind === 'merge' ? `Merge ${branch.name} into ${current}?` : `Rebase ${current} onto ${branch.name}?`, button = kind === 'merge' ? 'Merge' : 'Rebase';
    if (await vscode.window.showWarningMessage(redact(title), { modal: true, detail: integrationDetail(this.deps, preview, `${branch.name} (${oid})`) }, button) !== button) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Git Pro: ${button}` }, () => this.deps.advanced.execute(preview));
  }
}

/** How the Compare tab names a pinned ref in its header: the short branch or tag name, eight characters of an OID. */
export function refLabel(ref: string): string { return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(ref) ? ref.slice(0, 8) : ref.replace(/^refs\/(?:heads|remotes|tags)\//, ''); }

/** Builds the Compare tab with WP4's factory, publishes it for Tags → Compare With HEAD, and registers the entry points through the trusted wrapper. */
export function registerCompare(context: vscode.ExtensionContext, deps: FeatureDeps, command: TrustedCommand): void {
  const surface = createCompareSurface(context, deps); deps.surfaces.compare = surface;
  // Working-tree mode hands its chosen rows here; the files, paths and pin come from the tab's captured state, never from the webview.
  surface.getFromBranch = async request => {
    if (deps.git.repository(request.repositoryId).root !== request.root) throw new Error('Repository changed. Review Get from Branch again.');
    return getFromBranch(deps, { repositoryId: request.repositoryId, oid: request.ref.oid, name: refLabel(request.ref.name), files: request.files });
  };
  context.subscriptions.push(surface, { dispose: () => { if (deps.surfaces.compare === surface) delete deps.surfaces.compare; } });
  const commands = new CompareCommands(deps, surface);
  command('gitPro.compareWithCurrent', value => commands.compareWithCurrent(value));
  command('gitPro.diffWithWorkingTree', value => commands.diffWithWorkingTree(value));
  command('gitPro.compareBranches', (value, selected) => commands.compareBranches(value, selected));
  command('gitPro.compareWithBranch', value => commands.compareWithAnother(value));
  command('gitPro.compareWithRef', value => commands.compareWithRef(value));
  command('gitPro.mergeIntoCurrent', value => commands.integrate(value, 'merge'));
  command('gitPro.rebaseCurrentOnto', value => commands.integrate(value, 'rebase'));
}
