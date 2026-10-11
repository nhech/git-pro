import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ConflictRow, ConflictsApi, ConflictsOpenOptions, GitSideRef, MergeBridge, OperationSide, OperationSummary } from '../git/conflicts/conflict-contract';
import { CONFLICT_SCHEME, type ConflictSnapshots } from '../documents/conflict-snapshots';
import { mergeBlocker } from '../webviews/conflicts/conflicts-protocol';
import { redact } from '../security/redaction';
import { Emitter } from '../utils/events';
import type { Logger } from '../utils/logging';
import { allTabs, canonicalKey, fileKey, isUri, mergeInput, mergeTabFor, openDocumentUri, refuseUnsaved } from './open-files';
export { fileKey, mergeInput, type MergeTabInput } from './open-files';

const groups = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'];
/** Pane labels as built-in Git fills them (`$(git-commit) <sha7>` description, ref names or the WebStorm rebase wording as detail), with Git Pro's Yours/Theirs titles. */
function pane(title: 'Yours' | 'Theirs', side: OperationSide | undefined, ref: GitSideRef): { title: string; description: string; detail: string } {
  return { title, description: side?.oid ? `$(git-commit) ${side.oid.slice(0, 7)}` : `git --${ref.flag}`, detail: redact(side?.detail ?? (title === 'Yours' ? 'Your version' : 'Their version')) };
}

export interface BridgeDeps {
  readonly api: Pick<ConflictsApi, 'list' | 'previewBatch' | 'markResolved' | 'stageBlobs'>;
  /** Stages a file that still has marker lines once the user confirmed: ConflictsApi.markResolved refuses markers (N14), the single-file path takes `allowMarkers`. */
  readonly stageWithMarkers: (repositoryId: string, file: string) => Promise<void>;
  readonly authorize: (repositoryId: string, file: string) => Promise<string>;
  /** Repository and repository-relative path of an absolute file, or undefined outside the open repositories. */
  readonly locate: (file: string) => Promise<{ readonly id: string; readonly file: string } | undefined>;
  readonly active: () => string | undefined;
  readonly summary: (repositoryId: string) => Promise<OperationSummary | undefined>;
  /** Reveals the Conflicts tab (late-bound: it registers after the bridge). */
  readonly conflicts: (repositoryId: string, options?: ConflictsOpenOptions) => Promise<void>;
  readonly snapshots: ConflictSnapshots;
  readonly checkTrust: () => void;
  readonly logger: Logger;
  /** How long to wait for the merge tab: `_open.mergeEditor` resolves before the editor exists. */
  readonly timeoutMs?: number;
}
interface Session { readonly id: string; readonly file: string }

/**
 * §3.3: Merge… opens VS Code's merge editor with input1 (left) = Yours and input2 (right) = Theirs (owner decision Q1), mapped through `sidesFor` by the stage blobs.
 * It is also the only watcher of native Complete Merge: one completion gives one prompt.
 */
export class MergeEditorBridge implements MergeBridge, vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  /** Results that Apply & Next is completing: their tab closes without the native-completion prompt. */
  private readonly applying = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly queues = new Map<string, string[]>();
  /**
   * "Use Column Layout in Merge Editor" (§3.2) was chosen. `merge.columnLayout` acts on the active merge editor only and VS Code keeps the layout for later
   * ones (a profile-wide preference), so it runs once, on the next merge editor this bridge shows, and only after that explicit request.
   */
  private columnLayout = false;
  private readonly changed = new Emitter<void>();
  /** A merge tab opened or closed: the Conflicts tab redraws its `mergeOpen` column. */
  readonly onDidChange = this.changed.event;
  private readonly subscription: vscode.Disposable;
  constructor(private readonly deps: BridgeDeps) { this.subscription = vscode.window.tabGroups.onDidChangeTabs(event => this.tabsChanged(event)); }
  /** The merge tab on exactly this path: the one the bridge opened, whose Result Uri it chose. Merge editors opened elsewhere are found by `mergeTabFor`. */
  private mergeTab(file: string): vscode.Tab | undefined {
    const key = fileKey(file);
    return allTabs().find(tab => { const input = mergeInput(tab); return input?.result.scheme === 'file' && fileKey(input.result.fsPath) === key; });
  }
  async isOpen(file: string): Promise<boolean> { return await mergeTabFor(file) !== undefined; }
  /** Canonical file keys of every open merge editor's Result, for a whole table at once, whichever path VS Code or built-in Git opened it with. */
  async openResults(): Promise<ReadonlySet<string>> {
    const results = allTabs().flatMap(tab => { const input = mergeInput(tab); return input?.result.scheme === 'file' ? [input.result.fsPath] : []; });
    return new Set(await Promise.all(results.map(canonicalKey)));
  }
  open(repositoryId: string, file: string): Promise<boolean> { this.queues.delete(repositoryId); return this.show(repositoryId, file); }
  preferColumnLayout(): void { this.columnLayout = true; }
  /** Runs while the merge editor just shown is the active pane. */
  private async layout(): Promise<void> {
    if (!this.columnLayout) return;
    this.columnLayout = false;
    if ((await vscode.commands.getCommands(true)).includes('merge.columnLayout')) await vscode.commands.executeCommand('merge.columnLayout');
  }
  /** Merge… on several rows opens the first; Apply & Next walks the rest before the other unresolved files (§2.1). */
  openSequence(repositoryId: string, files: readonly string[]): Promise<boolean> {
    if (!files.length || files.length > 100) return Promise.reject(new Error('Select 1–100 conflicted files.'));
    this.queues.set(repositoryId, files.slice(1)); return this.show(repositoryId, files[0]!);
  }
  private async show(id: string, file: string): Promise<boolean> {
    this.deps.checkTrust();
    const absolute = await this.deps.authorize(id, file);
    // A document already open on this file under another path (an alias of the workspace folder) lends its Uri, so the Result keeps one model.
    const output = await openDocumentUri(absolute) ?? vscode.Uri.file(absolute), key = fileKey(output.fsPath);
    const existing = await mergeTabFor(absolute);
    if (existing) {
      // Never a second merge editor on one Result, whichever path opened it. A tab restored after a reload has expired inputs, so it is reopened instead ("Reopen merge").
      if (!this.expired(existing)) { await this.reveal(existing); await this.layout(); return true; }
      await vscode.window.tabGroups.close(existing);
      if (await mergeTabFor(absolute)) return false;
    }
    const row = (await this.deps.api.previewBatch(id, [file])).rows[0];
    if (!row) throw new Error('Select a current conflicted file.');
    if (!row.mergeable) throw new Error(`${redact(file)}: ${mergeBlocker(row)}`);
    const [blobs, summary] = await Promise.all([this.deps.api.stageBlobs(id, file), this.deps.summary(id).catch(() => undefined)]);
    const yours = blobs.sides.yours.stage === 2 ? blobs.ours : blobs.theirs, theirs = blobs.sides.theirs.stage === 2 ? blobs.ours : blobs.theirs, label = path.basename(absolute);
    const [base, left, right] = this.deps.snapshots.pinSet(key, [{ content: blobs.base, label }, { content: yours, label }, { content: theirs, label }]);
    const args = { base, input1: { uri: left, ...pane('Yours', summary?.yours, blobs.sides.yours) }, input2: { uri: right, ...pane('Theirs', summary?.theirs, blobs.sides.theirs) }, output };
    this.sessions.set(key, { id, file });
    // `getCommands(false)`: underscore ids are filtered out by `true`.
    if ((await vscode.commands.getCommands(false)).includes('_open.mergeEditor')) {
      const opened = await this.attempt(output.fsPath, () => vscode.commands.executeCommand('_open.mergeEditor', args));
      // Only a rejection falls back. A slow tab never does: a late `_open` tab plus a built-in one would be two merge editors on one Result.
      if (opened !== 'rejected') return this.settle(opened, key, output);
    }
    this.deps.snapshots.release(key);
    if ((await vscode.commands.getCommands(true)).includes('git.openMergeEditor')) {
      // It returns silently for a file outside built-in Git's repositories, so the tab is verified the same way.
      const opened = await this.attempt(output.fsPath, () => vscode.commands.executeCommand('git.openMergeEditor', output));
      if (opened !== 'rejected') return this.settle(opened, key, output);
    }
    this.sessions.delete(key);
    await vscode.commands.executeCommand('vscode.open', output);
    void vscode.window.showInformationMessage('Git Pro: Merge editor unavailable; resolve with the CodeLens, then Mark Resolved in Conflicts.');
    return true;
  }
  /** Runs one opener and waits up to the timeout for a merge tab on the file; `_open.mergeEditor` does not await the editor it opens. */
  private async attempt(file: string, run: () => Thenable<unknown>): Promise<boolean | 'rejected'> {
    let finish: (value: boolean) => void = () => undefined;
    const opened = new Promise<boolean>(resolve => { finish = resolve; });
    const check = () => { if (this.mergeTab(file)) done(true); };
    const subscription = vscode.window.tabGroups.onDidChangeTabs(check), timer = setTimeout(() => done(false), this.deps.timeoutMs ?? 10_000);
    const done = (value: boolean) => { clearTimeout(timer); subscription.dispose(); finish(value); };
    try { await run(); } catch (error) { done(false); this.deps.logger.error(`Merge editor rejected: ${error instanceof Error ? error.message : String(error)}`); return 'rejected'; }
    check(); return opened;
  }
  private async settle(opened: boolean, key: string, output: vscode.Uri): Promise<boolean> {
    this.changed.fire();
    // `_open.mergeEditor` opens with preserveFocus: true, so keyboard focus stays where it was until the active group is focused.
    if (opened) { await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'); await this.layout(); return true; }
    // A late tab still reads its released inputs until they are evicted.
    this.deps.snapshots.release(key);
    void Promise.resolve(vscode.window.showInformationMessage('Git Pro: The merge editor is still opening…', 'Open File')).then(choice => choice === 'Open File' ? vscode.commands.executeCommand('vscode.open', output) : undefined).then(undefined, () => undefined);
    return false;
  }
  private expired(tab: vscode.Tab): boolean {
    const input = mergeInput(tab);
    return input !== undefined && [input.base, input.input1, input.input2].some(uri => uri.scheme === CONFLICT_SCHEME && !this.deps.snapshots.has(uri));
  }
  /** Stable APIs cannot reveal a tab directly: focus its group, open it by index, then focus it. */
  private async reveal(tab: vscode.Tab): Promise<void> {
    const group = tab.group, index = group.tabs.indexOf(tab);
    if (!group.isActive) { const name = groups[group.viewColumn - 1]; if (name) await vscode.commands.executeCommand(`workbench.action.focus${name}EditorGroup`); }
    if (!tab.isActive && index >= 0) await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', index);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }
  /** The merge editor the editor-title button belongs to. `mergeEditor.acceptMerge` acts on the active editor pane only, so any other one is refused, as built-in `git.acceptMerge` does. */
  private async activeMerge(resource: unknown): Promise<{ id: string; file: string; absolute: string }> {
    const input = mergeInput(vscode.window.tabGroups.activeTabGroup.activeTab);
    if (!input || input.result.scheme !== 'file' || isUri(resource) && (resource.scheme !== 'file' || fileKey(resource.fsPath) !== fileKey(input.result.fsPath))) throw new Error('Focus the merge editor first.');
    const located = await this.deps.locate(input.result.fsPath);
    if (!located) throw new Error('This file is outside the open repositories.');
    return { ...located, absolute: input.result.fsPath };
  }
  /** Apply & Next (N5): stage only after `mergeEditor.acceptMerge` reports success; its unhandled-conflicts dialog is the confirmation, then the marker modal. */
  async apply(resource?: unknown): Promise<void> {
    this.deps.checkTrust();
    const target = await this.activeMerge(resource);
    if (!(await vscode.commands.getCommands(true)).includes('mergeEditor.acceptMerge')) throw new Error('Use Complete Merge, then Mark Resolved in Git Pro Conflicts.');
    const key = fileKey(target.absolute);
    this.applying.set(key, setTimeout(() => this.applying.delete(key), 5000));
    let result: { successful?: unknown } | undefined;
    try { result = await vscode.commands.executeCommand<{ successful?: unknown } | undefined>('mergeEditor.acceptMerge'); }
    finally { if (result?.successful !== true) { clearTimeout(this.applying.get(key)); this.applying.delete(key); } }
    if (result?.successful !== true) return;
    if (!await this.stage(target.id, target.file)) return;
    void vscode.window.showInformationMessage(`Git Pro: Staged ${redact(target.file)} (the saved Result).`);
    await this.next(target.id, target.file);
  }
  async nextFile(resource?: unknown): Promise<void> {
    this.deps.checkTrust();
    const located = await this.located(resource), id = located?.id ?? this.deps.active();
    if (!id) throw new Error('Select a repository first.');
    await this.next(id, located?.file);
  }
  async back(resource?: unknown): Promise<void> {
    const located = await this.located(resource), id = located?.id ?? this.deps.active();
    if (!id) throw new Error('Select a repository first.');
    await this.deps.conflicts(id, located ? { select: [located.file] } : {});
  }
  private async located(resource: unknown): Promise<{ id: string; file: string } | undefined> {
    const input = mergeInput(vscode.window.tabGroups.activeTabGroup.activeTab);
    const uri = isUri(resource) && resource.scheme === 'file' ? resource : input?.result.scheme === 'file' ? input.result : undefined;
    return uri ? this.deps.locate(uri.fsPath) : undefined;
  }
  /** The queued selection first, then the next unresolved mergeable file in path order; the Conflicts tab when none is left. */
  private async next(id: string, after?: string): Promise<void> {
    const mergeable = (await this.deps.api.list(id)).rows.filter(row => row.mergeable && row.path !== after), queue = this.queues.get(id) ?? [];
    let target: string | undefined;
    while (!target && queue.length) { const candidate = queue.shift()!; if (mergeable.some(row => row.path === candidate)) target = candidate; }
    if (!queue.length) this.queues.delete(id);
    target ??= (after === undefined ? undefined : mergeable.find(row => row.path > after))?.path ?? mergeable[0]?.path;
    if (target) { await this.show(id, target); return; }
    await this.deps.conflicts(id, after ? { select: [after] } : {});
  }
  /** Mark Resolved for one merged file: N12 dirty refusal, then the marker modal; without markers, ConflictsApi re-checks the fresh snapshot (N14). */
  private async stage(id: string, file: string): Promise<boolean> {
    const batch = await this.deps.api.previewBatch(id, [file]), row = batch.rows[0];
    if (!row) throw new Error('Select a current conflicted file.');
    // N12 on the canonical path; the merge tab that just completed may still be closing, so open merge tabs are not refused here.
    await refuseUnsaved([{ absolute: await this.deps.authorize(id, file), path: file }], { mergeTabs: false });
    if (row.markers?.present) {
      const choice = await vscode.window.showWarningMessage(`Conflict markers remain in ${redact(file)}. Stage it anyway?`, { modal: true, detail: 'Markers can become part of the commit. Review the result carefully.' }, 'Stage with markers');
      if (choice !== 'Stage with markers') return false;
      await this.deps.stageWithMarkers(id, file); return true;
    }
    await this.deps.api.markResolved(batch); return true;
  }
  private tabsChanged(event: vscode.TabChangeEvent): void {
    if (![...event.opened, ...event.closed, ...event.changed].some(tab => mergeInput(tab))) return;
    for (const tab of event.closed) {
      const input = mergeInput(tab);
      if (input?.result.scheme !== 'file' || this.mergeTab(input.result.fsPath)) continue;
      const key = fileKey(input.result.fsPath), session = this.sessions.get(key), applying = this.applying.get(key);
      this.deps.snapshots.release(key); this.sessions.delete(key);
      if (applying !== undefined) { clearTimeout(applying); this.applying.delete(key); continue; }
      if (session) void this.completed(session).catch((error: unknown) => this.deps.logger.error(`Merge completion check failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    this.changed.fire();
  }
  /** Native Complete Merge (Ctrl+Enter) saves without staging: offer Mark Resolved when the saved Result has no marker lines. Never stages by itself (D5). */
  private async completed({ id, file }: Session): Promise<void> {
    let row: ConflictRow | undefined;
    try { row = (await this.deps.api.previewBatch(id, [file])).rows[0]; } catch { return; }
    if (!row || row.binary || !row.workingFile || row.markers?.present !== false) return;
    const choice = await vscode.window.showInformationMessage(`Git Pro: ${redact(path.posix.basename(file))} merged. Stage it to mark it resolved?`, 'Mark Resolved', 'Open Conflicts');
    try {
      if (choice === 'Mark Resolved') { this.deps.checkTrust(); if (await this.stage(id, file)) void vscode.window.showInformationMessage(`Git Pro: Staged ${redact(file)}.`); }
      else if (choice === 'Open Conflicts') await this.deps.conflicts(id, { select: [file] });
    } catch (error) { void vscode.window.showErrorMessage(`Git Pro: ${redact(error instanceof Error ? error.message : String(error))}`); }
  }
  dispose(): void {
    this.subscription.dispose(); for (const timer of this.applying.values()) clearTimeout(timer);
    this.applying.clear(); this.sessions.clear(); this.queues.clear(); this.changed.dispose();
  }
}
