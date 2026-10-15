import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { lstat } from 'node:fs/promises';
import type { FeatureDeps } from '../../conflicts/surfaces';
import type { CompareFiles, CompareFilesMode, CompareSurface, CreateCompareSurface, MergeBase, PinnedRef, SideCommits } from './compare-contract';
import { NonUtf8Error, type ChangedFile, type FileStat, type HistoryCommit } from '../../git/history/history-parser';
import { BlobProvider } from '../../documents/blob-provider';
import { parseCompareAction, type CompareAction } from './compare-protocol';
import { compareHtml } from './compare-html';
import { redact } from '../../security/redaction';
import { historyPath } from '../../git/history/history-builders';
import { LinkOutsideError, refuseGitMetadata } from '../../security/paths';
import type { MenuContext } from '../menu-context';

/** What the Compare tab reads from the feature dependencies; a narrow type keeps the panel testable with stand-ins. */
export type CompareDeps = Pick<FeatureDeps, 'registry' | 'history' | 'policy' | 'revisions' | 'historyPanels' | 'git' | 'tools' | 'surfaces'>;
export interface CompareFileEntry { readonly status: string; readonly path: string; readonly originalPath?: string }
/** Working-tree mode's Get from Branch, run by WP5 (preview, modal, dirty-buffer guard, GitService.restoreFromSource). A rename row carries both paths. Resolves true when files changed. */
export interface GetFromBranchRequest { readonly repositoryId: string; readonly root: string; readonly ref: PinnedRef; readonly files: readonly CompareFileEntry[] }
export type GetFromBranch = (request: GetFromBranchRequest) => Promise<boolean>;
export type ChangesResource = readonly [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined];

const FILE_PAGE = 200, SIDE_PAGE = 25, ALL_CHANGES_LIMIT = 300;
const isOid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
const short = (oid: string | undefined) => oid ? oid.slice(0, 8) : 'Empty';
const failure = (error: unknown) => redact(error instanceof Error ? error.message : String(error));
const statKey = (file: { path: string; originalPath?: string }) => `${file.originalPath ?? ''}\0${file.path}`;
const statIndex = new WeakMap<CompareFiles, { exact: Map<string, FileStat>; byPath: Map<string, FileStat> }>();
function statFor(files: CompareFiles, file: ChangedFile): FileStat | undefined {
  let index = statIndex.get(files);
  if (!index) { index = { exact: new Map(files.stats.map(stat => [statKey(stat), stat])), byPath: new Map(files.stats.map(stat => [stat.path, stat])) }; statIndex.set(files, index); }
  return index.exact.get(statKey(file)) ?? index.byPath.get(file.path);
}
/** Multi-diff tabs expose the proposed TabInputTextMultiDiff at runtime only, so they are recognised by shape, never by instanceof. */
export function isMultiDiffInput(input: unknown): boolean { return Boolean(input) && typeof input === 'object' && Array.isArray((input as { textDiffs?: unknown }).textDiffs); }
/** A multi-diff tab opened with this title: 1.100 labels it with the title, newer hosts (1.141) add a file count such as " (1 file)". */
export function isChangesTab(tab: Pick<vscode.Tab, 'label' | 'input'>, title: string): boolean {
  return isMultiDiffInput(tab.input) && (tab.label === title || tab.label.startsWith(`${title} (`) && tab.label.endsWith(')'));
}
/** `vscode.changes` always opens a new tab: an earlier multi-diff tab with this title closes first. A text or webview tab that shares the label stays open. */
export async function openChangesTab(title: string, resources: readonly ChangesResource[]): Promise<void> {
  const previous = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => isChangesTab(tab, title));
  if (previous.length) await vscode.window.tabGroups.close(previous, true);
  await vscode.commands.executeCommand('vscode.changes', title, resources.map(resource => [...resource]));
}

interface Side { readonly ref: string; readonly label: string; readonly oid: string; readonly current: boolean }
interface FilesView { readonly files: CompareFiles; readonly commit?: HistoryCommit }
interface Loaded { readonly fork?: MergeBase; readonly leftOnly?: SideCommits; readonly rightOnly?: SideCommits; readonly branchFiles: CompareFiles; readonly view: FilesView; readonly offset: number }
const panelKey = (repositoryId: string, mode: 'commits' | 'worktree', left: string, right: string | undefined, folder?: string) => JSON.stringify([repositoryId, mode, left, right ?? null, ...(folder ? [folder] : [])]);
const sameFiles = (a: CompareFiles, b: CompareFiles) => a.omitted === b.omitted && a.note === b.note && JSON.stringify([a.files, a.stats]) === JSON.stringify([b.files, b.stats]);
/** A path whose working side is not a regular file of this repository (a submodule, a symlink, a nested repository or Git metadata). */
class NoWorkingSide extends Error {}
const leftOut = (count: number) => count === 1 ? 'Left out 1 file that has no regular working file (a symlink, submodule, nested repository or Git metadata); use native Git for it.'
  : `Left out ${count.toLocaleString()} files that have no regular working file (symlinks, submodules, nested repositories or Git metadata); use native Git for them.`;

class ComparePanel {
  readonly panel: vscode.WebviewPanel;
  private readonly session = randomUUID();
  private readonly subscriptions: { dispose(): void }[];
  private revision = 0; private generation = 0; private busy = false; private disposed = false; private stale = false; private swapped = false;
  private controller: AbortController | undefined; private timer: ReturnType<typeof setTimeout> | undefined;
  private loaded: Loaded | undefined; private loadError: string | undefined; private moved: readonly string[] = [];
  /** Refs that no longer resolve, and whether the repository was closed: neither is a moved ref, and Refresh cannot re-pin them. */
  private gone: readonly string[] = []; private expired = false;
  private refs = new Map<string, string[]>();
  private filesMode: CompareFilesMode;
  /** Which changed files the list shows (a name fragment and change types); the captured list itself never changes, so every index still names the same file. */
  private filter = { text: '', statuses: '' };
  private readonly menu: { dispose(): void } | undefined;
  constructor(private readonly owner: ComparePanels, readonly repositoryId: string, readonly root: string, readonly mode: 'commits' | 'worktree', private left: Side, private right: Side | undefined, readonly folder?: string) {
    const configured = vscode.workspace.getConfiguration('gitPro', vscode.Uri.file(root)).get('compare.defaultFilesMode');
    this.filesMode = configured === 'tips' ? 'tips' : 'fork';
    const media = vscode.Uri.joinPath(owner.context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('gitPro.compare', this.title(), vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: false });
    // WebviewPanel.iconPath takes no ThemeIcon on the 1.100 baseline, so the tab shows a light/dark pair of the git-compare codicon.
    this.panel.iconPath = { light: vscode.Uri.joinPath(media, 'operation-icons', 'git-compare-light.svg'), dark: vscode.Uri.joinPath(media, 'operation-icons', 'git-compare-dark.svg') };
    const nonce = randomUUID().replace(/-/g, ''), resource = (name: string) => this.panel.webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
    // receive() never rejects; returning its promise lets a caller await one message, as the History panel's listener does.
    this.subscriptions = [this.panel.webview.onDidReceiveMessage(raw => this.receive(raw)), this.panel.onDidDispose(() => this.dispose(true))];
    this.panel.webview.html = compareHtml({ session: this.session, nonce, cspSource: this.panel.webview.cspSource, resource });
    // Stand-in dependencies in tests carry no surfaces, and a tab without the router simply has no native menu.
    this.menu = owner.deps.surfaces?.menus.register('gitPro.compare', this.session, { repositoryId, knowsCommit: oid => this.knowsCommit(oid), handle: (action, context) => this.menuAction(action, context) });
  }
  get key(): string { return panelKey(this.repositoryId, this.mode, this.left.oid, this.right?.oid, this.folder); }
  /** A folder comparison lists only the files inside it (a rename counts when either path is inside). */
  private inFolder(files: CompareFiles): CompareFiles {
    const folder = this.folder; if (!folder) return files;
    const within = (value: string | undefined) => value !== undefined && (value === folder || value.startsWith(`${folder}/`));
    const kept = files.files.filter(file => within(file.path) || within(file.originalPath)), paths = new Set(kept.map(file => file.path));
    return Object.freeze({ ...files, files: Object.freeze(kept), stats: Object.freeze(files.stats.filter(stat => paths.has(stat.path))) });
  }
  get isDisposed(): boolean { return this.disposed; }
  reveal(): void { this.panel.reveal(); }
  load(): Promise<void> { return this.run(async signal => { const loaded = await this.compute(this.left, this.right, signal); if (this.disposed) return false; this.loaded = loaded; this.loadError = undefined; void this.loadRefs(); return true; }); }
  /** A registry invalidation may mean a ref moved or the working tree changed; checks wait for a visible, idle tab. */
  schedule(delay = 750): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.background(); }, delay);
  }
  private title(): string {
    const right = this.right ? this.right.label : 'Working Tree', where = this.folder ? ` · ${this.folder}` : '';
    return redact(this.swapped ? `Compare: ${right} ↔ ${this.left.label}${where}` : `Compare: ${this.left.label} ↔ ${right}${where}`);
  }
  private post(value: Record<string, unknown>): Promise<boolean> { return this.disposed ? Promise.resolve(false) : Promise.resolve(this.panel.webview.postMessage({ ...value, session: this.session })); }
  private state(): Record<string, unknown> {
    const side = (value: Side) => ({ name: redact(value.label), oid: value.oid, current: value.current }), head = this.owner.head(this.repositoryId);
    const base = { type: 'state', revision: this.revision, mode: this.mode, left: side(this.left), ...(this.right ? { right: side(this.right) } : {}), swapped: this.swapped, ...(head ? { head: redact(head) } : {}), ...(this.folder ? { folder: redact(this.folder) } : {}), filesMode: this.filesMode, moved: this.moved.map(redact), gone: this.gone.map(redact), filter: this.filter, ...(this.expired ? { expired: true } : {}) };
    const loaded = this.loaded;
    if (!loaded) return { ...base, loading: !this.loadError, ...(this.loadError ? { error: this.loadError } : {}) };
    const commit = (value: HistoryCommit) => ({ oid: value.oid, subject: redact(value.subject.slice(0, 500)), author: redact(value.author.slice(0, 200)), timestamp: value.timestamp, refs: (this.refs.get(value.oid) ?? []).map(name => redact(name.slice(0, 200))) });
    const page = (value: SideCommits) => ({ count: value.count, offset: value.offset, commits: value.commits.map(commit) });
    const files = loaded.view.files, worktree = files.scope === 'worktree';
    const shown = this.visible(files);
    const items = shown.slice(loaded.offset, loaded.offset + FILE_PAGE).map(({ file, index }) => {
      const stat = statFor(files, file), letter = file.status.charAt(0);
      return { index, status: letter, path: redact(file.path), ...(file.originalPath ? { originalPath: redact(file.originalPath) } : {}), added: stat ? stat.added : null, removed: stat ? stat.removed : null, binary: stat?.added === null,
        ...(worktree ? { presence: letter === 'A' ? 'worktree' : letter === 'D' ? 'branch' : 'both' } : {}) };
    });
    return { ...base, loading: false, ...(loaded.fork ? { fork: { oid: loaded.fork.oid, multiple: loaded.fork.multiple, ...(loaded.fork.shallow ? { shallow: true } : {}) } } : {}),
      ...(loaded.leftOnly && loaded.rightOnly ? { sides: { leftOnly: page(loaded.leftOnly), rightOnly: page(loaded.rightOnly) } } : {}),
      files: { scope: files.scope, ...(loaded.view.commit ? { commit: { oid: loaded.view.commit.oid, subject: redact(loaded.view.commit.subject.slice(0, 500)) } } : {}), ...(files.from ? { from: files.from } : {}), ...(files.to ? { to: files.to } : {}),
        total: shown.length, ...(shown.length === files.files.length ? {} : { unfiltered: files.files.length }), offset: loaded.offset, omitted: files.omitted, ...(files.note ? { note: files.note } : {}), binary: shown.filter(({ file }) => statFor(files, file)?.added === null).length, items } };
  }
  /** One request at a time per tab. A task that returns false changed nothing the webview shows, so the revision stays and no state is posted. */
  private async run(task: (signal: AbortSignal) => Promise<boolean>): Promise<void> {
    if (this.busy) throw new Error('Wait for the current Compare action to finish.');
    const generation = ++this.generation, controller = this.controller = new AbortController();
    this.busy = true; await this.post({ type: 'busy', busy: true });
    try { if (await task(controller.signal) && generation === this.generation && !this.disposed) { this.revision++; await this.post(this.state()); } }
    catch (error) {
      if (this.disposed || generation !== this.generation) return;
      if (this.loaded) await this.post({ type: 'error', message: failure(error) }); else { this.loadError = failure(error); await this.post(this.state()); }
    } finally {
      if (this.controller === controller) this.controller = undefined;
      this.busy = false;
      if (!this.disposed) { await this.post({ type: 'busy', busy: false }); if (this.stale) this.schedule(0); }
    }
  }
  /** A commit this tab lists: one of the two sides' loaded pages, or the commit whose files are shown. */
  private knowsCommit(oid: string): boolean { const loaded = this.loaded; return Boolean(loaded) && (this.sideCommits(loaded!).some(commit => commit.oid === oid) || loaded!.view.commit?.oid === oid); }
  /** A native context-menu command. It becomes the message the tab itself would send, so the session, the revision and the loaded rows are checked the same way and a stale menu fails with the same words. */
  private async menuAction(action: string, context: MenuContext): Promise<void> {
    const { revision, index, oid, indexes } = context.values, base = { session: this.session, revision };
    switch (action) {
      case 'showFiles': return this.receive({ ...base, type: 'selectCommit', oid });
      case 'showInHistory': return this.receive({ ...base, type: 'showInHistory', oid });
      case 'diff': case 'localDiff': case 'openFile': case 'copyPath': return this.receive({ ...base, type: action, index });
      case 'getFromBranch': return this.receive({ ...base, type: 'getFromBranch', indexes: typeof indexes === 'string' && /^\d{1,7}(?:,\d{1,7}){0,99}$/.test(indexes) ? indexes.split(',').map(Number) : undefined });
    }
    throw new Error('Unknown Compare menu action.');
  }
  private async receive(raw: unknown): Promise<void> {
    try {
      const action = parseCompareAction(raw);
      if (this.disposed || action.session !== this.session) throw new Error('Compare session expired. Open the comparison again.');
      // The renderer is recreated when the tab is shown again; readiness replays the captured state without reading Git.
      if (action.type === 'ready') { await this.post(this.state()); await this.post({ type: 'busy', busy: this.busy }); if (this.stale && !this.busy) this.schedule(0); return; }
      if (action.type === 'refresh') { await this.run(signal => this.refresh(signal)); return; }
      const loaded = this.loaded; if (!loaded) throw new Error('Wait for the comparison to load.');
      if (action.revision !== this.revision) throw new Error('Comparison changed. Review again.');
      await this.run(signal => this.handle(action, loaded, signal));
    } catch (error) { await this.post({ type: 'error', message: failure(error) }); }
  }
  private async handle(action: Exclude<CompareAction, { type: 'ready' | 'refresh' }>, loaded: Loaded, signal: AbortSignal): Promise<boolean> {
    const history = this.owner.deps.history, id = this.repositoryId;
    switch (action.type) {
      case 'swap': {
        if (this.mode === 'worktree') { this.swapped = !this.swapped; this.panel.title = this.title(); return true; }
        const left = this.right!, right = this.left, files = await history.comparisonFiles(id, left.oid, right.oid, this.filesMode, signal, loaded.fork);
        if (this.disposed) return false;
        const previous = this.key; this.left = left; this.right = right;
        // The pins and the selected commit stay; only the direction of the views changes.
        this.loaded = { ...loaded, ...(loaded.rightOnly ? { leftOnly: loaded.rightOnly } : {}), ...(loaded.leftOnly ? { rightOnly: loaded.leftOnly } : {}), branchFiles: files, view: loaded.view.commit ? loaded.view : { files }, offset: loaded.view.commit ? loaded.offset : 0 };
        this.owner.rekey(this, previous); this.panel.title = this.title(); return true;
      }
      case 'page': {
        const list = action.side === 'left' ? loaded.leftOnly : loaded.rightOnly; if (!list || !this.right) throw new Error('Commit lists are unavailable in this view.');
        if (Math.abs(action.offset - list.offset) !== SIDE_PAGE || action.offset >= list.count) throw new Error('Choose an adjacent commit page.');
        const [tip, exclude] = action.side === 'left' ? [this.left.oid, this.right.oid] : [this.right.oid, this.left.oid];
        const commits = await history.comparisonPage(id, tip, exclude, action.offset, signal); if (this.disposed) return false;
        const next: SideCommits = Object.freeze({ count: list.count, offset: action.offset, commits: Object.freeze(commits) });
        this.loaded = { ...loaded, ...(action.side === 'left' ? { leftOnly: next } : { rightOnly: next }) }; return true;
      }
      case 'selectCommit': {
        if (!this.sideCommits(loaded).some(commit => commit.oid === action.oid)) throw new Error('Select a commit from the loaded lists.');
        const details = await history.details(id, action.oid, 0, signal); if (this.disposed) return false;
        const files: CompareFiles = Object.freeze({ scope: 'commit', from: details.parent, to: details.commit.oid, files: Object.freeze(details.files), stats: Object.freeze(details.stats), omitted: 'filesOmitted' in details, ...(details.filesNote ? { note: details.filesNote } : {}) });
        // The comparison and its pages stay; "All changes" returns to them.
        this.loaded = { ...loaded, view: { files, commit: details.commit }, offset: 0 }; return true;
      }
      case 'allChanges': this.loaded = { ...loaded, view: { files: loaded.branchFiles }, offset: 0 }; return true;
      case 'filesMode': {
        if (!this.right) throw new Error('Files modes apply to branch comparisons.');
        const files = await history.comparisonFiles(id, this.left.oid, this.right.oid, action.mode, signal, loaded.fork); if (this.disposed) return false;
        this.filesMode = action.mode; this.loaded = { ...loaded, branchFiles: files, view: { files }, offset: 0 }; return true;
      }
      case 'filter': this.filter = { text: action.text, statuses: action.statuses }; this.loaded = { ...loaded, offset: 0 }; return true;
      case 'filesPage': {
        const total = this.visible(loaded.view.files).length;
        if (action.offset > 0 && action.offset >= total) throw new Error('Choose an available file page.');
        this.loaded = { ...loaded, offset: action.offset }; return true;
      }
      case 'diff': case 'localDiff': case 'openFile': await this.open(action.type, loaded, this.file(loaded, action.index), signal); return false;
      case 'copyPath': await vscode.env.clipboard.writeText(this.file(loaded, action.index).path); return false;
      case 'openAll': await this.openAll(loaded); return false;
      case 'getFromBranch': return this.getFromBranch(loaded, action.indexes, signal);
      case 'copyRevision': case 'showInHistory': {
        if (![...this.sideCommits(loaded), ...(loaded.view.commit ? [loaded.view.commit] : [])].some(commit => commit.oid === action.oid)) throw new Error('Select a commit from the loaded lists.');
        if (action.type === 'copyRevision') await vscode.env.clipboard.writeText(action.oid); else this.owner.deps.historyPanels.open(id, undefined, action.oid, true);
        return false;
      }
    }
  }
  /** The files the list shows, each with its index in the captured list: actions name that index, never a position in the filtered list. */
  private visible(files: CompareFiles): { file: ChangedFile; index: number }[] {
    const { text, statuses } = this.filter, needle = text.toLowerCase(), all = files.files.map((file, index) => ({ file, index }));
    if (!needle && !statuses) return all;
    return all.filter(({ file }) => (!statuses || statuses.includes(file.status.charAt(0))) && (!needle || file.path.toLowerCase().includes(needle) || (file.originalPath?.toLowerCase().includes(needle) ?? false)));
  }
  private sideCommits(loaded: Loaded): readonly HistoryCommit[] { return [...(loaded.leftOnly?.commits ?? []), ...(loaded.rightOnly?.commits ?? [])]; }
  private file(loaded: Loaded, index: number): ChangedFile { const file = loaded.view.files.files[index]; if (!file) throw new Error('Select a file from the current comparison.'); return file; }
  private async compute(left: Side, right: Side | undefined, signal: AbortSignal): Promise<Loaded> {
    const history = this.owner.deps.history;
    if (!right) { const files = this.inFolder(await history.worktreeFiles(this.repositoryId, left.oid, signal)); return { branchFiles: files, view: { files }, offset: 0 }; }
    const result = await history.compareRefs(this.repositoryId, left.oid, right.oid, this.filesMode, signal);
    return { fork: result.fork, leftOnly: result.leftOnly, rightOnly: result.rightOnly, branchFiles: result.files, view: { files: result.files }, offset: 0 };
  }
  /** Refresh re-resolves the ref names to new pins; a pin chosen as an exact OID stays. */
  private async refresh(signal: AbortSignal): Promise<boolean> {
    const resolve = async (side: Side): Promise<Side> => {
      if (isOid(side.ref)) return side;
      // A closed repository fails every read; that is its own message, not a ref that stopped resolving.
      const oid = await this.owner.deps.history.resolveRef(this.repositoryId, side.ref, signal).catch((error: unknown) => { if (!this.repositoryOpen) throw error; throw new Error(`${side.label} no longer resolves to a commit; the comparison keeps its pinned commits.`); });
      return this.owner.side(this.repositoryId, side.ref, oid);
    };
    const left = await resolve(this.left), right = this.right ? await resolve(this.right) : undefined, loaded = await this.compute(left, right, signal);
    if (this.disposed) return false;
    const previous = this.key; this.left = left; this.right = right; this.loaded = loaded; this.loadError = undefined; this.moved = []; this.gone = []; this.expired = false;
    this.owner.rekey(this, previous); this.panel.title = this.title(); void this.loadRefs(); return true;
  }
  private get repositoryOpen(): boolean { return this.owner.deps.registry.list().some(item => item.id === this.repositoryId); }
  private async background(): Promise<void> {
    if (this.disposed) return;
    if (!this.panel.visible || this.busy || !this.loaded) { this.stale = true; return; }
    this.stale = false; const generation = this.generation, history = this.owner.deps.history, sides = [this.left, ...(this.right ? [this.right] : [])].filter(side => !isOid(side.ref));
    // Closed (registry.sync without it): nothing can be read or re-pinned until it opens again, which is no reason to say a ref moved. The pins and files stay.
    const expire = async () => { if (this.expired) return; this.expired = true; this.moved = []; this.gone = []; await this.post(this.state()); };
    if (!this.repositoryOpen) { await expire(); return; }
    try {
      const resolved = await Promise.all(sides.map(side => history.resolveRef(this.repositoryId, side.ref).then(oid => oid !== side.oid ? 'moved' : 'same', () => 'gone')));
      const files = this.mode === 'worktree' ? this.inFolder(await history.worktreeFiles(this.repositoryId, this.left.oid)) : undefined;
      if (this.disposed) return;
      if (generation !== this.generation || this.busy || !this.loaded) { this.stale = true; return; }
      if (!this.repositoryOpen) { await expire(); return; }
      const named = (kind: string) => sides.flatMap((side, index) => resolved[index] === kind ? [side.label] : []), moved = named('moved'), gone = named('gone');
      let changed = this.expired || moved.join('\n') !== this.moved.join('\n') || gone.join('\n') !== this.gone.join('\n'); this.moved = moved; this.gone = gone; this.expired = false;
      // The working tree is live: its file list follows edits, while branch comparisons keep their pins and only say that a ref moved.
      if (files && !sameFiles(files, this.loaded.branchFiles)) { this.loaded = { branchFiles: files, view: { files }, offset: this.loaded.offset < this.visible(files).length ? this.loaded.offset : 0 }; this.revision++; changed = true; }
      if (changed) await this.post(this.state());
    } catch {
      this.stale = false;
      // A failed background check leaves the comparison as it is; Refresh reports the error. Only a repository closed meanwhile is said here.
      if (!this.disposed && !this.repositoryOpen) await expire();
    }
  }
  private async loadRefs(): Promise<void> {
    try {
      const [branches, tags] = await Promise.all([this.owner.deps.git.branchSearchSnapshot(this.repositoryId).catch(() => []), this.owner.deps.tools.tags(this.repositoryId).catch(() => [])]);
      if (this.disposed) return;
      const refs = new Map<string, string[]>(), add = (oid: string, name: string) => { const names = refs.get(oid) ?? []; if (names.length < 4) names.push(name); refs.set(oid, names); };
      for (const branch of branches) add(branch.oid, branch.name); for (const tag of tags) add(tag.target, tag.name);
      // Badges change no captured data, so they post without a new revision, even while another request runs.
      this.refs = refs; await this.post(this.state());
    } catch { /* Ref badges are decoration only. */ }
  }
  /** Diff sides for a file row: the OIDs the current files view was diffed from and to, or undefined for the working tree and for a side where the file is absent. */
  private sides(loaded: Loaded, file: ChangedFile): { from: string | undefined; to: string | undefined; labels: [string, string] } {
    const files = loaded.view.files, absentFrom = file.status === 'A', absentTo = file.status === 'D';
    const labels: [string, string] = files.scope === 'commit' ? [files.from ? `${short(files.from)}` : 'Empty', short(files.to)] : files.scope === 'fork' ? [`fork ${short(files.from)}`, `${this.left.label} ${short(files.to)}`]
      : files.scope === 'tips' ? [`${this.left.label} ${short(files.from)}`, `${this.right?.label ?? ''} ${short(files.to)}`] : [`${this.left.label} ${short(files.from)}`, 'Working Tree'];
    return { from: absentFrom ? undefined : files.from, to: absentTo ? undefined : files.to, labels };
  }
  /** Diffs open beside the tab with focus left in it, so the list stays in view and the next click replaces the diff (a preview editor). */
  private diffOptions(): vscode.TextDocumentShowOptions | undefined {
    return vscode.workspace.getConfiguration('gitPro', vscode.Uri.file(this.root)).get<boolean>('compare.openDiffsBeside', true) === false ? undefined : { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true };
  }
  private async open(kind: 'diff' | 'localDiff' | 'openFile', loaded: Loaded, file: ChangedFile, signal: AbortSignal): Promise<void> {
    const history = this.owner.deps.history, revisions = this.owner.deps.revisions, id = this.repositoryId, name = path.posix.basename(file.path), before = file.originalPath ?? file.path;
    if (kind === 'openFile') { const uri = await this.workingFile(file.path); if (!uri) throw new Error(`${name} does not exist in the working tree.`); await vscode.commands.executeCommand('vscode.open', uri); return; }
    if (statFor(loaded.view.files, file)?.added === null) throw new Error(`${name}: binary file — no text diff.`);
    const { from, to, labels } = this.sides(loaded, file), worktree = loaded.view.files.scope === 'worktree';
    if (kind === 'localDiff' || worktree) {
      // The real file is the editable side; the revision side is a read-only snapshot.
      const blobOid = worktree ? from : to ?? from, blobPath = worktree || !to ? before : file.path, label = worktree ? labels[0] : to ? labels[1] : labels[0];
      const [content, working] = await Promise.all([history.revision(id, blobOid, blobPath, signal), this.workingFile(file.path)]);
      if (this.disposed || signal.aborted) return;
      if (!working && !worktree) throw new Error(`${name} does not exist in the working tree.`);
      const snapshot = revisions.add(content, blobPath), local = working ?? revisions.add(Buffer.alloc(0), file.path);
      const [left, right, leftLabel, rightLabel] = worktree && this.swapped ? [local, snapshot, 'Working Tree', label] : [snapshot, local, label, 'Working Tree'];
      await vscode.commands.executeCommand('vscode.diff', left, right, redact(`${name} (${leftLabel} ↔ ${rightLabel})`), this.diffOptions()); return;
    }
    const [left, right] = await Promise.all([history.revision(id, from, before, signal), history.revision(id, to, file.path, signal)]);
    if (this.disposed || signal.aborted) return;
    await vscode.commands.executeCommand('vscode.diff', revisions.add(left, before), revisions.add(right, file.path), redact(`${name} (${labels[0]} ↔ ${labels[1]})`), this.diffOptions());
  }
  private async openAll(loaded: Loaded): Promise<void> {
    const files = loaded.view.files;
    if (files.omitted) throw new Error(files.note === 'nonUtf8Path' ? 'Some changed paths are not valid UTF-8, so Git Pro cannot list or open them here. Use a terminal for this comparison.' : 'Too many changed files to list here. Open files one at a time or use native Git.');
    // Open All Changes opens what the list shows: with a filter, only the files that match it.
    const shown = this.visible(files).map(({ file }) => file), filtered = shown.length !== files.files.length;
    const text = shown.filter(file => statFor(files, file)?.added !== null), chosen = text.slice(0, ALL_CHANGES_LIMIT);
    if (!chosen.length) throw new Error(shown.length ? 'Only binary files changed; there is no text diff to open.' : files.files.length ? 'No files match the filter.' : 'No differences.');
    const worktree = files.scope === 'worktree', blobs = this.owner.blobs, resources: ChangesResource[] = [];
    let skipped = 0;
    for (let start = 0; start < chosen.length; start += 32) for (const resource of await Promise.all(chosen.slice(start, start + 32).map(async (file): Promise<ChangesResource | undefined> => {
      const { from, to } = this.sides(loaded, file), label = vscode.Uri.file(path.join(this.root, ...file.path.split('/')));
      const left = from ? blobs.add(this.repositoryId, from, file.originalPath ?? file.path) : undefined;
      if (!worktree) return [label, left, to ? blobs.add(this.repositoryId, to, file.path) : undefined];
      // One submodule or symlink row has no editable side; it is left out, so the other files still open.
      const working = file.status === 'D' ? undefined : await this.workingFile(file.path).catch((error: unknown) => { if (!(error instanceof NoWorkingSide)) throw error; skipped++; return null; });
      if (working === null) return undefined;
      return this.swapped ? [label, working, left] : [label, left, working];
    }))) if (resource) resources.push(resource);
    if (this.disposed) return;
    if (!resources.length) throw new Error(leftOut(skipped));
    const view = loaded.view.commit ? `${short(loaded.view.commit.oid)} ${loaded.view.commit.subject.slice(0, 80)}` : filtered ? 'Filtered Changes' : 'All Changes';
    await openChangesTab(redact(`${this.title()} · ${view}`), resources);
    const notices = [...(text.length > chosen.length ? [`Opened the first ${ALL_CHANGES_LIMIT} of ${text.length.toLocaleString()} text files.`] : []), ...(skipped ? [leftOut(skipped)] : [])];
    if (notices.length) await this.post({ type: 'notice', message: notices.join(' ') });
  }
  private async getFromBranch(loaded: Loaded, indexes: readonly number[], signal: AbortSignal): Promise<boolean> {
    if (this.mode !== 'worktree' || loaded.view.files.scope !== 'worktree') throw new Error('Get from Branch is available when comparing a branch with the working tree.');
    const handler = this.owner.getFromBranch; if (!handler) throw new Error('Get from Branch is not available in this build.');
    const files = indexes.map(index => this.file(loaded, index)).map(file => Object.freeze({ status: file.status, path: file.path, ...(file.originalPath ? { originalPath: file.originalPath } : {}) }));
    if (!await handler(Object.freeze({ repositoryId: this.repositoryId, root: this.root, ref: Object.freeze({ name: this.left.ref, oid: this.left.oid }), files: Object.freeze(files) })) || this.disposed) return false;
    const refreshed = this.inFolder(await this.owner.deps.history.worktreeFiles(this.repositoryId, this.left.oid, signal)); if (this.disposed) return false;
    this.loaded = { branchFiles: refreshed, view: { files: refreshed }, offset: loaded.offset < this.visible(refreshed).length ? loaded.offset : 0 }; return true;
  }
  /** The real working file as an editable side: same repository, inside the root, a regular file and not Git metadata. Undefined when it does not exist. */
  private async workingFile(relative: string): Promise<vscode.Uri | undefined> {
    historyPath(relative);
    // A tracked link that leads out of the repository (or loops) has no editable side either, so it is left out like any other symlink.
    const absolute = await this.owner.deps.policy.authorizeFile(this.root, relative).catch((error: unknown) => {
      if (error instanceof LinkOutsideError || (error as NodeJS.ErrnoException | undefined)?.code === 'ELOOP') throw new NoWorkingSide(error instanceof Error ? error.message : String(error));
      throw error;
    });
    // By name and by where it really leads: a branch can carry `link/config` where the working tree has a tracked symlink (or a Windows 8.3 name GIT~1) into .git.
    const repo = this.owner.deps.registry.list().find(item => item.id === this.repositoryId); if (!repo) throw new Error('Repository is no longer open.');
    await refuseGitMetadata(repo, relative, absolute).catch((error: unknown) => { throw new NoWorkingSide(error instanceof Error ? error.message : String(error)); });
    const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info) return undefined;
    if (!info.isFile() || info.isSymbolicLink()) throw new NoWorkingSide('Only regular files open from Compare; use native Git for symlinks and submodules.');
    if ((await this.owner.deps.registry.resolveFile(absolute))?.id !== this.repositoryId) throw new NoWorkingSide('This file belongs to another repository.');
    return vscode.Uri.file(absolute);
  }
  dispose(closed = false): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++; this.controller?.abort(); this.controller = undefined;
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.menu?.dispose(); this.loaded = undefined; this.refs.clear(); this.owner.forget(this);
    if (!closed) this.panel.dispose();
  }
}

/**
 * The Compare tab (design §3.7, §3.8): one tab per (repository, left pin, right pin), or per (repository, branch pin) against the working tree.
 * Refs are validated and pinned to OIDs before a tab opens; the webview only names loaded commits and file indexes.
 */
export class ComparePanels implements CompareSurface, vscode.Disposable {
  private readonly panels = new Map<string, ComparePanel>();
  private readonly live = new Set<ComparePanel>();
  private readonly subscription: { dispose(): void };
  /** Get from Branch for working-tree mode; registerCompare (WP5) sets it. */
  getFromBranch: GetFromBranch | undefined;
  constructor(readonly context: Pick<vscode.ExtensionContext, 'extensionUri'>, readonly deps: CompareDeps, readonly blobs: BlobProvider, private readonly owned: readonly { dispose(): void }[] = []) {
    this.subscription = deps.registry.onDidInvalidate(() => { for (const panel of this.live) panel.schedule(); });
  }
  get activePanelCount(): number { return this.live.size; }
  async openRefs(repositoryId: string, leftRef: string, rightRef: string): Promise<void> {
    const repo = this.repository(repositoryId), [left, right] = await Promise.all([this.deps.history.resolveRef(repositoryId, leftRef), this.deps.history.resolveRef(repositoryId, rightRef)]);
    await this.show(panelKey(repositoryId, 'commits', left, right), () => new ComparePanel(this, repositoryId, repo.root, 'commits', this.side(repositoryId, leftRef, left), this.side(repositoryId, rightRef, right)));
  }
  async openWorktree(repositoryId: string, ref: string, folder?: string): Promise<void> {
    const repo = this.repository(repositoryId), oid = await this.deps.history.resolveRef(repositoryId, ref);
    if (folder !== undefined) { historyPath(folder); if (folder.endsWith('/') || folder.includes('\\') || folder.includes('\0') || folder.split('/').includes('.git')) throw new Error('Choose a folder inside the repository.'); }
    await this.show(panelKey(repositoryId, 'worktree', oid, undefined, folder), () => new ComparePanel(this, repositoryId, repo.root, 'worktree', this.side(repositoryId, ref, oid), undefined, folder));
  }
  private async show(key: string, create: () => ComparePanel): Promise<void> {
    const existing = this.panels.get(key);
    if (existing && !existing.isDisposed) { existing.reveal(); return; }
    const panel = create(); this.panels.set(key, panel); this.live.add(panel);
    // Load failures show in the tab itself, so the command that opened it does not also report them.
    await panel.load();
  }
  /** Display name and current-branch marker for a pinned ref; the brand accent marks only the checked-out branch. */
  side(repositoryId: string, ref: string, oid: string): Side {
    const head = this.head(repositoryId), label = ref === 'HEAD' ? head ?? 'HEAD' : isOid(ref) ? ref.slice(0, 8) : ref.replace(/^refs\/(?:heads|remotes|tags)\//, '');
    return Object.freeze({ ref, label, oid, current: Boolean(head) && (ref === 'HEAD' || ref === head || ref === `refs/heads/${head}`) });
  }
  head(repositoryId: string): string | undefined { const head = this.deps.registry.store.get(repositoryId)?.head; return head && head !== '(detached)' ? head : undefined; }
  rekey(panel: ComparePanel, previous: string): void { if (this.panels.get(previous) === panel) this.panels.delete(previous); if (!this.panels.has(panel.key)) this.panels.set(panel.key, panel); }
  forget(panel: ComparePanel): void { this.live.delete(panel); for (const [key, value] of this.panels) if (value === panel) this.panels.delete(key); }
  private repository(id: string) { const repo = this.deps.registry.list().find(item => item.id === id); if (!repo) throw new Error('Repository is no longer open.'); return repo; }
  dispose(): void {
    this.subscription.dispose();
    for (const panel of [...this.live]) panel.dispose();
    this.panels.clear(); this.live.clear(); this.getFromBranch = undefined;
    for (const item of this.owned) item.dispose();
  }
}

/** WP5's registerCompare calls this, sets deps.surfaces.compare and pushes the result to context.subscriptions. It also registers the `git-pro-blob:` provider. */
export const createCompareSurface = ((context, deps) => {
  // Open All Changes cannot tell a side that is not UTF-8 without reading every file first, so such a side opens as a read-only notice instead of failing.
  const blobs = new BlobProvider({ revision: (id, oid, file, signal) => deps.history.revision(id, oid, file, signal).catch((error: unknown) => {
    if (!(error instanceof NonUtf8Error)) throw error;
    // The commit is named so that two non-UTF-8 versions of one file are not shown as identical notices (which a multi-diff would read as "no change").
    return Buffer.from(`This version of ${path.posix.basename(file)} (${(oid ?? '').slice(0, 8)}) is not UTF-8 text, so Git Pro cannot show it here. Use native Git to compare it.\n`);
  }) });
  return new ComparePanels(context, deps, blobs, [vscode.workspace.registerTextDocumentContentProvider(BlobProvider.scheme, blobs), blobs]);
}) satisfies CreateCompareSurface;
