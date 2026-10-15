import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ConflictList, ConflictRow, ConflictsApi, ConflictsOpenOptions, ConflictsSurface, MergeBridge, OperationSide } from '../../git/conflicts/conflict-contract';
import type { RepositoryRegistry } from '../../repositories/repository-registry';
import type { ConflictActions } from './conflict-actions';
import { conflictsHtml } from './conflicts-html';
import { mergeBlocker, parseConflictsRequest, type ConflictsOperationState, type ConflictsRequest, type ConflictsRowState, type ConflictsSideState } from './conflicts-protocol';
import { fileKey } from '../../editor/merge-editor-bridge';
import { redact } from '../../security/redaction';
import type { Logger } from '../../utils/logging';
import type { MenuContext, MenuRouter } from '../menu-context';

type Group = 'unresolved' | 'resolved';
interface Captured { readonly group: Group; readonly row: ConflictRow }
interface Tab {
  readonly id: string; readonly root: string; readonly panel: vscode.WebviewPanel; readonly session: string;
  /** Bumped whenever the posted rows (keys, so paths and groups) change; requests built from older rows are refused. */
  revision: number; identity: string; rows: Map<string, Captured>; list: ConflictList | undefined; error: string | undefined;
  /** Same operation fingerprint as the paths in `resolved`; a different one clears them (§3.2 Groups). */
  operation: string | undefined; previous: Map<string, ConflictRow>; resolved: Map<string, ConflictRow>;
  /** Captured from a Git Pro Pop while it had conflicts: the summary drops the source once the count reaches 0, the moment [Drop Stash…] is offered. */
  stash: { readonly selector: string; readonly oid: string } | undefined;
  selection: string[]; select: readonly string[] | undefined;
  busy: boolean; disposed: boolean; loading: AbortController | undefined; generation: number; timer: ReturnType<typeof setTimeout> | undefined;
  /** The store snapshot the rows were read from; another one means the rows are stale. */
  loaded: unknown; state: Record<string, unknown> | undefined;
}
export interface ConflictsPanelDeps {
  readonly registry: Pick<RepositoryRegistry, 'list' | 'onDidChange' | 'store' | 'select' | 'active'>;
  readonly api: Pick<ConflictsApi, 'list'>;
  readonly bridge: MergeBridge & { openSequence(repositoryId: string, files: readonly string[]): Promise<boolean>; openResults(): Promise<ReadonlySet<string>>; preferColumnLayout(): void;
    readonly onDidChange: (listener: () => void) => { dispose(): void } };
  readonly actions: Pick<ConflictActions, 'accept' | 'markResolved' | 'compare' | 'openFile' | 'dropStash'>;
  readonly checkTrust: () => void;
  readonly logger: Logger;
  /** Where a tab registers its session so that the native right-click menu can reach it; a tab without it has no menu. */
  readonly menus?: MenuRouter;
}
const count = (value: number) => `${value} ${value === 1 ? 'file' : 'files'}`;
const message = (error: unknown) => redact(error instanceof Error ? error.message : String(error));
const side = (value: OperationSide, flag: 'ours' | 'theirs'): ConflictsSideState => ({ label: value.label, ...(value.ref ? { ref: redact(value.ref) } : {}), ...(value.oid ? { oid: value.oid } : {}), ...(value.subject ? { subject: redact(value.subject.slice(0, 200)) } : {}), flag });

/** §3.2: one `gitPro.conflicts` editor tab per repository. Rows, labels and the operation all come from the host's captured list; the webview sends keys and a revision (N1). */
export class ConflictsPanels implements ConflictsSurface, vscode.Disposable {
  private readonly tabs = new Map<string, Tab>();
  private readonly subscriptions: { dispose(): void }[];
  /** `merge.columnLayout` (internal, 1.100 and 1.141) exists: the "Use Column Layout in Merge Editor" item is hidden otherwise (§3.2). */
  private columnLayout = false;
  constructor(private readonly context: Pick<vscode.ExtensionContext, 'extensionUri'>, private readonly deps: ConflictsPanelDeps) {
    this.subscriptions = [deps.registry.onDidChange(() => this.registryChanged()), deps.bridge.onDidChange(() => { for (const tab of this.tabs.values()) if (tab.list) void this.post(tab); }),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('gitPro.conflicts.groupByDirectory')) for (const tab of this.tabs.values()) void this.post(tab); })];
    void Promise.resolve().then(() => vscode.commands.getCommands(true)).then(ids => {
      this.columnLayout = ids.includes('merge.columnLayout'); if (this.columnLayout) for (const tab of this.tabs.values()) if (tab.list) void this.post(tab);
    }, () => undefined);
  }
  get openCount(): number { return this.tabs.size; }
  /** Resolves once the tab is revealed, before its rows load: the failure toast waits for it. */
  async open(repositoryId: string, options: ConflictsOpenOptions = {}): Promise<void> {
    this.deps.checkTrust();
    const repo = this.deps.registry.list().find(item => item.id === repositoryId);
    if (!repo) throw new Error('Repository is no longer open.');
    const select = options.select?.filter(file => typeof file === 'string').slice(0, 100), existing = this.tabs.get(repositoryId);
    if (existing) {
      existing.panel.reveal(undefined, options.preserveFocus === true);
      if (select?.length) { existing.select = select; if (existing.list) await this.post(existing); }
      return;
    }
    const panel = vscode.window.createWebviewPanel('gitPro.conflicts', `Conflicts — ${redact(path.basename(repo.root))}`, { viewColumn: vscode.ViewColumn.Active, preserveFocus: options.preserveFocus === true },
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')], retainContextWhenHidden: false });
    // WebviewPanel.iconPath takes no ThemeIcon in @types/vscode 1.100, so the codicon ships as a light/dark SVG pair.
    panel.iconPath = { light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'operation-icons', 'git-merge-light.svg'), dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'operation-icons', 'git-merge-dark.svg') };
    const tab: Tab = { id: repositoryId, root: repo.root, panel, session: randomUUID(), revision: 0, identity: '', rows: new Map(), list: undefined, error: undefined, operation: undefined, previous: new Map(), resolved: new Map(),
      stash: undefined, selection: [], select, busy: false, disposed: false, loading: undefined, generation: 0, timer: undefined, loaded: undefined, state: undefined };
    this.tabs.set(repositoryId, tab);
    const receive = panel.webview.onDidReceiveMessage(raw => { void this.receive(tab, raw); });
    const menu = this.deps.menus?.register('gitPro.conflicts', tab.session, { repositoryId, handle: (action, context) => this.menuAction(tab, action, context) });
    const disposed = panel.onDidDispose(() => {
      tab.disposed = true; tab.loading?.abort(); if (tab.timer) clearTimeout(tab.timer); receive.dispose(); disposed.dispose(); menu?.dispose();
      tab.rows.clear(); tab.previous.clear(); tab.resolved.clear(); tab.list = undefined; tab.state = undefined;
      if (this.tabs.get(repositoryId) === tab) this.tabs.delete(repositoryId);
    });
    const nonce = randomUUID().replace(/-/g, '');
    panel.webview.html = conflictsHtml({ session: tab.session, nonce, cspSource: panel.webview.cspSource, resource: name => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name)).toString() });
    void this.load(tab);
  }
  private key(id: string, group: Group, file: string): string { return createHash('sha256').update(JSON.stringify([id, group, file])).digest('base64url'); }
  private registryChanged(): void {
    for (const tab of this.tabs.values()) {
      if (tab.disposed) continue;
      if (!this.deps.registry.list().some(repo => repo.id === tab.id)) { tab.loading?.abort(); tab.generation++; tab.list = undefined; tab.loaded = undefined; tab.error = 'Repository is no longer open.'; void this.post(tab); continue; }
      if (this.deps.registry.store.get(tab.id) === tab.loaded) continue;
      // A hidden tab has no renderer (retainContextWhenHidden: false); it reloads when the renderer sends `ready`.
      if (!tab.panel.visible) { tab.loaded = undefined; continue; }
      tab.timer ??= setTimeout(() => { tab.timer = undefined; void this.load(tab); }, 50);
    }
  }
  private async load(tab: Tab): Promise<void> {
    if (tab.disposed) return;
    tab.loading?.abort(); const controller = new AbortController(), generation = ++tab.generation; tab.loading = controller;
    const snapshot = this.deps.registry.store.get(tab.id);
    try {
      const list = await this.deps.api.list(tab.id, controller.signal);
      if (tab.disposed || generation !== tab.generation) return;
      tab.loaded = snapshot; tab.error = undefined; this.install(tab, list);
    } catch (error) {
      if (tab.disposed || generation !== tab.generation) return;
      const text = message(error); tab.loaded = undefined; this.deps.logger.error(`Conflicts list failed: ${text}`);
      // Rows already shown stay (every action re-reads its files on a fresh snapshot); the failure is a notice until the next read.
      if (tab.list) { await tab.panel.webview.postMessage({ type: 'error', session: tab.session, message: text }); return; }
      tab.error = text;
    } finally { if (tab.loading === controller) tab.loading = undefined; }
    await this.post(tab);
  }
  private install(tab: Tab, list: ConflictList): void {
    const summary = list.summary, operation = JSON.stringify(summary.operation === 'idle' ? ['idle', summary.yours.oid ?? null] : [summary.operation, summary.yours.oid ?? null, summary.theirs.oid ?? null, summary.progress?.current ?? null]);
    if (operation !== tab.operation) { tab.operation = operation; tab.previous.clear(); tab.resolved.clear(); tab.stash = undefined; }
    if (summary.source?.kind === 'stashPop') tab.stash = { selector: summary.source.selector, oid: summary.source.oid };
    const current = new Map(list.rows.map(row => [row.path, row]));
    // A path past the 5000-row cut is not resolved; only an untruncated list proves that a path left the conflicts group.
    if (!list.truncated) for (const [file, row] of tab.previous) if (!current.has(file)) tab.resolved.set(file, row);
    for (const file of current.keys()) tab.resolved.delete(file);
    tab.previous = current; tab.list = list;
  }
  /** `open`: canonical file keys of the open merge editors' Results. */
  private state(tab: Tab, open: ReadonlySet<string>): Record<string, unknown> {
    const groupByDirectory = vscode.workspace.getConfiguration('gitPro', vscode.Uri.file(tab.root)).get<boolean>('conflicts.groupByDirectory', false) === true;
    const base = { type: 'state', session: tab.session, repository: redact(path.basename(tab.root)), groupByDirectory, columnLayout: this.columnLayout };
    const list = tab.list, rows = new Map<string, Captured>(), items: ConflictsRowState[] = [];
    if (list) {
      const add = (group: Group, row: ConflictRow) => {
        const key = this.key(tab.id, group, row.path); rows.set(key, { group, row });
        items.push({ key, group, path: redact(row.path), kind: row.kind, yours: row.yours, theirs: row.theirs, markers: row.markers ? row.markers.present ? 'present' : 'none' : 'unknown', blocks: row.markers?.blocks ?? null,
          binary: row.binary, mergeable: row.mergeable, ...(row.unsupported ? { unsupported: redact(row.unsupported) } : {}), mergeOpen: open.has(fileKey(path.join(tab.root, ...row.path.split('/')))), workingFile: row.workingFile });
      };
      for (const row of list.rows) add('unresolved', row);
      for (const row of [...tab.resolved.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) add('resolved', row);
    }
    // The operation is part of what a request was reviewed against (§3.11): a new operation on the same paths refuses requests built for the old one.
    const identity = JSON.stringify([tab.list ? tab.operation ?? null : null, ...rows.keys()]);
    if (identity !== tab.identity) { tab.identity = identity; tab.revision++; }
    tab.rows = rows; tab.selection = tab.selection.filter(key => rows.has(key));
    if (!list) return { ...base, revision: tab.revision, operation: null, rows: [], truncated: false, message: tab.error ?? 'Loading conflicts…' };
    const summary = list.summary, sourceStash = summary.source?.kind === 'stashApply' ? { selector: redact(summary.source.selector), drop: false } : undefined;
    const operation: ConflictsOperationState = { kind: summary.operation, title: redact(summary.title), yours: side(summary.yours, summary.sides.yours.flag), theirs: side(summary.theirs, summary.sides.theirs.flag),
      ...(summary.progress ? { progress: { current: summary.progress.current, total: summary.progress.total } } : {}), conflicts: summary.conflicts,
      canContinue: summary.canContinue, canSkip: summary.canSkip, canAbort: summary.canAbort, nativeOnly: summary.nativeOnly, editStop: summary.editStop,
      ...(tab.stash ? { stash: { selector: redact(tab.stash.selector), drop: true } } : sourceStash ? { stash: sourceStash } : {}) };
    return { ...base, revision: tab.revision, operation, rows: items, truncated: list.truncated, message: '' };
  }
  private async post(tab: Tab): Promise<void> {
    if (tab.disposed) return;
    const open = tab.list ? await this.deps.bridge.openResults() : new Set<string>();
    if (tab.disposed) return;
    const state = this.state(tab, open); tab.state = state;
    await tab.panel.webview.postMessage(state);
    if (!tab.select || !tab.list || tab.disposed) return;
    const wanted = new Set(tab.select), keys = [...tab.rows].filter(([, captured]) => wanted.has(captured.row.path)).map(([key]) => key);
    tab.select = undefined; if (!keys.length) return;
    tab.selection = keys; await tab.panel.webview.postMessage({ type: 'select', session: tab.session, keys });
  }
  private postBusy(tab: Tab): Thenable<boolean> { return tab.disposed ? Promise.resolve(false) : tab.panel.webview.postMessage({ type: 'busy', session: tab.session, busy: tab.busy }); }
  private notice(tab: Tab, text: string): Thenable<boolean> { return tab.disposed ? Promise.resolve(false) : tab.panel.webview.postMessage({ type: 'notice', session: tab.session, message: redact(text) }); }
  private captured(tab: Tab, key: string, group?: Group): ConflictRow {
    const found = tab.rows.get(key);
    if (!found || group && found.group !== group) throw new Error(group === 'unresolved' && found ? 'Select unresolved files only.' : 'Conflicts changed. Review again.');
    return found.row;
  }
  /**
   * A native right-click menu command, turned into the request the tab itself would send. The row's key and revision come from the element, the files from the selection this
   * tab already tracks (the row is selected first), so a stale or forged menu is refused like any other request.
   */
  private async menuAction(tab: Tab, action: string, context: MenuContext): Promise<void> {
    const { key, revision } = context.values, base = { session: tab.session, revision };
    const keys = typeof key === 'string' && tab.selection.length > 1 && tab.selection.includes(key) ? [...tab.selection] : [key];
    switch (action) {
      case 'merge': return this.receive(tab, { ...base, type: 'open', action, key, ...(keys.length > 1 ? { keys } : {}) });
      case 'acceptYours': case 'acceptTheirs': case 'markResolved': return this.receive(tab, { ...base, type: 'resolve', action, keys });
      case 'openFile': return this.receive(tab, { ...base, type: 'open', action: 'file', key });
      case 'compareBaseYours': case 'compareBaseTheirs': case 'compareYoursTheirs': return this.receive(tab, { ...base, type: 'open', action, key });
    }
    throw new Error('Unknown Conflicts menu action.');
  }
  private async receive(tab: Tab, raw: unknown): Promise<void> {
    let owned = false, mutated = false;
    try {
      const request = parseConflictsRequest(raw);
      if (tab.disposed || request.session !== tab.session) throw new Error('Conflicts session expired.');
      if (request.type === 'ready') {
        // The renderer is recreated whenever the tab is shown again: replay unchanged rows instead of reading them again.
        if (tab.state && tab.list && tab.loaded === this.deps.registry.store.get(tab.id)) {
          await this.post(tab);
          if (tab.selection.length) await tab.panel.webview.postMessage({ type: 'select', session: tab.session, keys: tab.selection, restore: true });
          if (tab.busy) await this.postBusy(tab);
        } else await this.load(tab);
        return;
      }
      if (request.type === 'select') { tab.selection = request.keys.filter(key => tab.rows.has(key)); return; }
      if (request.type === 'refresh') { await this.load(tab); return; }
      if (request.type === 'columnLayout') {
        if (!this.columnLayout) throw new Error('This VS Code has no column layout for the merge editor.');
        this.deps.bridge.preferColumnLayout(); await this.notice(tab, 'The next merge editor opens in the column layout: Yours | Result | Theirs. VS Code keeps it for later merges.'); return;
      }
      if (request.type === 'setting') { await this.groupByDirectory(tab, request.groupByDirectory); return; }
      if (request.type === 'operation' && request.action === 'close') { tab.panel.dispose(); return; }
      if (tab.busy) throw new Error('Wait for the current Conflicts action to finish.');
      if (request.revision !== tab.revision) { await this.post(tab); throw new Error('Conflicts changed. Review again.'); }
      tab.busy = owned = true; await this.postBusy(tab);
      mutated = await this.run(tab, request);
    } catch (error) { if (!tab.disposed) await tab.panel.webview.postMessage({ type: 'error', session: tab.session, message: message(error) }); }
    finally {
      if (owned) { tab.busy = false; await this.postBusy(tab); if (mutated) await this.load(tab); }
    }
  }
  /** Returns whether the repository may have changed, so the rows are read again. */
  private async run(tab: Tab, request: Extract<ConflictsRequest, { revision: number }>): Promise<boolean> {
    this.deps.checkTrust();
    const summary = tab.list?.summary;
    if (request.type === 'resolve') {
      const files = request.keys.map(key => this.captured(tab, key, 'unresolved').path);
      if (request.action === 'markResolved') { await this.deps.actions.markResolved(tab.id, files); await this.notice(tab, `Marked ${count(files.length)} resolved.`); return true; }
      const yours = request.action === 'acceptYours', accepted = await this.deps.actions.accept(tab.id, files, yours ? 'yours' : 'theirs', summary);
      if (accepted) await this.notice(tab, `Accepted ${yours ? 'Yours' : 'Theirs'} for ${count(files.length)} and staged ${files.length === 1 ? 'it' : 'them'}.`);
      return accepted;
    }
    if (request.type === 'open') {
      if (request.action === 'file') { await this.deps.actions.openFile(tab.id, this.captured(tab, request.key).path); return false; }
      if (request.action === 'merge') {
        const rows = (request.keys ?? [request.key]).map(key => this.captured(tab, key, 'unresolved')), blocked = rows.find(row => !row.mergeable);
        if (blocked) throw new Error(`${redact(blocked.path)}: ${mergeBlocker(blocked)}`);
        await this.deps.bridge.openSequence(tab.id, rows.map(row => row.path)); return false;
      }
      await this.deps.actions.compare(tab.id, this.captured(tab, request.key, 'unresolved').path, request.action, summary); return false;
    }
    if (request.action === 'scm') { await vscode.commands.executeCommand('workbench.view.scm'); return false; }
    if (request.action === 'dropStash') {
      const stash = tab.stash;
      if (!stash || tab.list?.rows.length) throw new Error('Drop Stash is offered after a Git Pro stash pop once its conflicts are resolved.');
      const dropped = await this.deps.actions.dropStash(tab.id, stash);
      if (dropped) { tab.stash = undefined; await this.notice(tab, `Dropped ${stash.selector}.`); }
      return dropped;
    }
    // Continue, Skip and Abort keep their own modals in the operation commands; they act on the active repository, which is this tab's.
    if (this.deps.registry.active?.id !== tab.id) this.deps.registry.select(tab.id);
    await vscode.commands.executeCommand(`gitPro.operation.${request.action}`, tab.id);
    return true;
  }
  /** Persisted where the effective value comes from, so the toggle never writes a workspace file that shadows nothing. */
  private async groupByDirectory(tab: Tab, value: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('gitPro', vscode.Uri.file(tab.root)), inspected = config.inspect<boolean>('conflicts.groupByDirectory');
    const target = inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update('conflicts.groupByDirectory', value, target);
  }
  dispose(): void { for (const subscription of this.subscriptions) subscription.dispose(); for (const tab of [...this.tabs.values()]) tab.panel.dispose(); this.tabs.clear(); }
}
