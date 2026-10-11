import * as vscode from 'vscode';
import * as path from 'node:path';
import type { FeatureDeps, TrustedCommand } from '../conflicts/surfaces';
import type { ConflictsApi, ConflictsOpenOptions, OperationSummary } from '../git/conflicts/conflict-contract';
import { CONFLICT_SCHEME, ConflictSnapshots } from '../documents/conflict-snapshots';
import { MergeEditorBridge } from '../editor/merge-editor-bridge';
import { ConflictActions } from '../webviews/conflicts/conflict-actions';
import { ConflictsPanels } from '../webviews/conflicts/conflicts-panel';
import { canonicalFilePath } from '../security/paths';

async function locate(deps: Pick<FeatureDeps, 'registry'>, file: string): Promise<{ id: string; file: string } | undefined> {
  const repo = await deps.registry.resolveFile(file);
  return repo ? { id: repo.id, file: path.relative(repo.root, await canonicalFilePath(file)).replace(/\\/g, '/') } : undefined;
}
/**
 * What the argument-only commands act on: an editor-title or explorer Uri, a Changes-view conflict row (with the rows selected with it), or (repositoryId, paths).
 * The paths are checked again by ConflictsApi against a fresh snapshot.
 */
export async function conflictTargets(deps: Pick<FeatureDeps, 'registry'>, args: readonly unknown[]): Promise<{ id: string; paths: string[] }> {
  const [first, second] = args;
  if (first instanceof vscode.Uri) {
    if (first.scheme !== 'file') throw new Error('Choose a conflicted file.');
    const located = await locate(deps, first.fsPath);
    if (!located) throw new Error('File is outside the open repositories.');
    return { id: located.id, paths: [located.file] };
  }
  if (typeof first === 'string' && Array.isArray(second) && second.length && second.every(item => typeof item === 'string')) return { id: first, paths: [...second as string[]] };
  const row = (value: unknown) => {
    const item = value as { kind?: unknown; repositoryId?: unknown; change?: { path?: unknown; group?: unknown } } | undefined;
    return item?.kind === 'file' && typeof item.repositoryId === 'string' && typeof item.change?.path === 'string' && item.change.group === 'conflicts' ? { id: item.repositoryId, file: item.change.path } : undefined;
  };
  const rows = (Array.isArray(second) && second.length ? second : [first]).map(row);
  if (rows.length && rows.every(Boolean)) {
    const id = rows[0]!.id;
    if (rows.some(item => item!.id !== id)) throw new Error('Choose conflicts from one repository.');
    return { id, paths: rows.map(item => item!.file) };
  }
  throw new Error('Select conflicted files in Git Pro first.');
}
const openOptions = (value: unknown): ConflictsOpenOptions => {
  const item = value && typeof value === 'object' ? value as { select?: unknown; preserveFocus?: unknown } : {};
  const select = Array.isArray(item.select) ? item.select.filter((file): file is string => typeof file === 'string').slice(0, 100) : undefined;
  return { ...(select?.length ? { select } : {}), ...(item.preserveFocus === true ? { preserveFocus: true } : {}) };
};

/** WP2: the Conflicts tab (§3.2) and the merge-editor bridge (§3.3), published on `deps.surfaces` for the failure auto-open, the watcher and the Changes view. */
export function registerConflicts(context: vscode.ExtensionContext, deps: FeatureDeps, command: TrustedCommand): void {
  const api: ConflictsApi = deps.conflicts, snapshots = new ConflictSnapshots(), checkTrust = () => deps.policy.checkTrust();
  // Labels only: a failed read leaves the panes and the modal with their generic Yours/Theirs wording.
  const summary = (id: string): Promise<OperationSummary | undefined> => (deps.surfaces.operation ?? deps.conflicts.context).summary(id).catch(() => undefined);
  const authorize = (id: string, file: string) => deps.git.authorizePath(id, file);
  const open = (id: string, options?: ConflictsOpenOptions): Promise<void> => {
    const surface = deps.surfaces.conflicts;
    return surface ? surface.open(id, options) : Promise.reject(new Error('Git Pro Conflicts is unavailable.'));
  };
  const bridge = new MergeEditorBridge({ api, snapshots, logger: deps.logger, checkTrust, authorize, summary, conflicts: open,
    stageWithMarkers: async (id, file) => deps.conflicts.resolve(await deps.conflicts.preview(id, file), 'mark', true),
    locate: file => locate(deps, file), active: () => deps.registry.active?.id });
  const actions = new ConflictActions({ api, revisions: deps.revisions, tools: deps.tools, summary, checkTrust, authorize, root: id => deps.git.repository(id).root });
  const panels = new ConflictsPanels(context, { registry: deps.registry, api, bridge, actions, checkTrust, logger: deps.logger });
  deps.surfaces.conflicts = panels; deps.surfaces.mergeBridge = bridge;
  context.subscriptions.push(snapshots, vscode.workspace.registerTextDocumentContentProvider(CONFLICT_SCHEME, snapshots), bridge, panels,
    { dispose: () => { if (deps.surfaces.conflicts === panels) delete deps.surfaces.conflicts; if (deps.surfaces.mergeBridge === bridge) delete deps.surfaces.mergeBridge; } });
  command('gitPro.conflicts.open', async (...args) => {
    const [first] = args;
    if (first === undefined) { const id = deps.registry.active?.id; if (!id) throw new Error('Select a repository first.'); await open(id); return; }
    if (typeof first === 'string') { await open(first, openOptions(args[1])); return; }
    const target = await conflictTargets(deps, args); await open(target.id, { select: target.paths });
  });
  for (const [id, side] of [['gitPro.conflicts.acceptYours', 'yours'], ['gitPro.conflicts.acceptTheirs', 'theirs']] as const)
    command(id, async (...args) => { const target = await conflictTargets(deps, args); await actions.accept(target.id, target.paths, side); });
  command('gitPro.conflicts.merge', async (...args) => { const target = await conflictTargets(deps, args); await bridge.openSequence(target.id, target.paths); });
  command('gitPro.mergeEditor.apply', resource => bridge.apply(resource));
  command('gitPro.mergeEditor.nextFile', resource => bridge.nextFile(resource));
  command('gitPro.mergeEditor.back', resource => bridge.back(resource));
}
