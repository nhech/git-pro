import * as vscode from 'vscode';
import * as path from 'node:path';
import type { HistoryService } from '../git/history/history.service';
import type { RepositoryRegistry } from '../repositories/repository-registry';
import type { RemoteLinks } from '../git/remote-links.service';
import { ageBucket, ageBuckets, blockAt, escapeMarkdown, gutterText, type BlameBlock, type BlameFile } from '../git/history/blame-file';
import { canonicalFilePath } from '../security/paths';
import { validateOid } from '../security/refs';
import { describeAge } from '../utils/age';
import { recoveryFor } from '../utils/recovery';

/** Warm for what changed lately, cool for what did not: a tint behind the gutter text that works on a light and a dark theme alike. The last one is for lines not committed yet. */
const tints = ['rgba(242,84,45,0.34)', 'rgba(245,133,46,0.32)', 'rgba(244,183,64,0.30)', 'rgba(190,194,66,0.28)', 'rgba(108,185,110,0.26)', 'rgba(70,170,170,0.26)', 'rgba(78,134,200,0.26)', 'rgba(120,120,160,0.24)', 'rgba(128,128,128,0.22)'];
const cardCommands = ['gitPro.blame.openCommit', 'gitPro.blame.copyHash', 'gitPro.blame.openOnRemote'] as const;
/** What a link in a card carries: the repository and the full ID of a commit that the card showed. */
export interface BlameTarget { readonly repositoryId: string; readonly oid: string }
interface Shown { readonly repositoryId: string; readonly relative: string; head: string; file: BlameFile | undefined; generation: number; request: AbortController | undefined; timer: ReturnType<typeof setTimeout> | undefined }

/**
 * Blame of a whole file in the gutter. Toggle File Blame puts, before each line, the commit's short hash, its author and how long ago, on a tint that runs from warm (recent) to cool (old)
 * down the lines that one commit wrote; hovering the gutter opens a card with the subject and links. It shows the saved file only: an edit removes it until the file is saved, since the
 * lines would no longer match. The read is one `git blame --porcelain` of a file of at most 1 MiB, repeated when HEAD moves or the file is saved.
 */
export class FileBlame implements vscode.Disposable {
  private readonly types = Array.from({ length: ageBuckets + 1 }, (_, index) => vscode.window.createTextEditorDecorationType({
    before: { backgroundColor: tints[index]!, color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 1.5ch 0 0', ...(index === ageBuckets ? { fontStyle: 'italic' } : {}) } }));
  private readonly shown = new Map<string, Shown>();
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;
  constructor(private readonly history: HistoryService, private readonly registry: RepositoryRegistry, private readonly links: Pick<RemoteLinks, 'web' | 'commit'>,
    private readonly openCommit: (repositoryId: string, oid: string) => void, private readonly now: () => number = Date.now) {
    this.subscriptions = [
      vscode.languages.registerHoverProvider({ scheme: 'file' }, { provideHover: (document, position) => this.hover(document, position) }),
      vscode.workspace.onDidChangeTextDocument(event => {
        const state = this.shown.get(event.document.uri.toString()); if (!state || !event.contentChanges.length) return;
        // The lines no longer match the blame: it goes away, and comes back when the file is saved (or the edits are undone).
        this.paint(event.document.uri.toString(), true); if (!event.document.isDirty) this.schedule(event.document.uri.toString());
      }),
      vscode.workspace.onDidSaveTextDocument(document => { if (this.shown.has(document.uri.toString())) this.schedule(document.uri.toString()); }),
      vscode.workspace.onDidCloseTextDocument(document => this.forget(document.uri.toString())),
      vscode.window.onDidChangeVisibleTextEditors(() => { for (const key of this.shown.keys()) this.paint(key); }),
      this.registry.onDidChange(() => { for (const [key, state] of this.shown) if ((this.registry.store.get(state.repositoryId)?.oid ?? '') !== state.head) this.schedule(key); }),
    ];
  }
  /** On for the file in the active editor, or off when it is on. */
  async toggle(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') throw new Error('Open a file in a repository first.');
    const key = editor.document.uri.toString();
    if (this.shown.has(key)) { this.forget(key); return; }
    if (editor.document.isDirty) throw new Error('Save the file first: blame reads the saved version.');
    const repo = await this.registry.resolveFile(editor.document.uri.fsPath); if (!repo) throw new Error('This file is not in an open repository.');
    const relative = path.relative(repo.root, await canonicalFilePath(editor.document.uri.fsPath)).replace(/\\/g, '/');
    if (this.disposed || this.shown.has(key)) return;
    this.shown.set(key, { repositoryId: repo.id, relative, head: this.registry.store.get(repo.id)?.oid ?? '', file: undefined, generation: 0, request: undefined, timer: undefined });
    await this.refresh(key);
  }
  private schedule(key: string): void {
    const state = this.shown.get(key); if (!state || this.disposed) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => { state.timer = undefined; void this.refresh(key).catch(() => undefined); }, 300);
  }
  private async refresh(key: string): Promise<void> {
    const state = this.shown.get(key); if (!state || this.disposed) return;
    state.request?.abort(); const request = state.request = new AbortController(), generation = ++state.generation;
    const reading = this.history.blameFile(state.repositoryId, state.relative, request.signal);
    vscode.window.setStatusBarMessage('Git Pro: reading blame…', reading.then(() => undefined, () => undefined));
    try {
      const file = await reading;
      if (this.disposed || this.shown.get(key) !== state || state.generation !== generation) return;
      state.file = file; state.head = this.registry.store.get(state.repositoryId)?.oid ?? ''; state.request = undefined;
      this.paint(key);
    } catch (error) {
      if (this.disposed || this.shown.get(key) !== state || state.generation !== generation) return;
      this.forget(key);
      await vscode.window.showErrorMessage(`Git Pro: ${recoveryFor(error).message}`);
    }
  }
  /** The decorations of every visible editor of the document: the blame of its lines, or none (`clear`, or the file has unsaved edits). */
  private paint(key: string, clear = false): void {
    const state = this.shown.get(key); if (!state) return;
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== key) continue;
      const groups: vscode.DecorationOptions[][] = this.types.map(() => []);
      if (!clear && state.file && !editor.document.isDirty) {
        const now = this.now();
        for (const block of state.file.blocks) {
          const bucket = block.commit.uncommitted ? ageBuckets : ageBucket(block.commit.timestamp, now);
          for (let offset = 0; offset < block.length && block.start + offset < editor.document.lineCount; offset++)
            groups[bucket]!.push({ range: new vscode.Range(block.start + offset, 0, block.start + offset, 0), renderOptions: { before: { contentText: gutterText(block, now, offset === 0) } } });
        }
      }
      this.types.forEach((type, index) => editor.setDecorations(type, groups[index]!));
    }
  }
  /** Off for the document: its decorations go, and a read in progress stops. */
  private forget(key: string): void {
    const state = this.shown.get(key); if (!state) return;
    state.request?.abort(); if (state.timer) clearTimeout(state.timer);
    this.shown.delete(key); state.file = undefined;
    for (const editor of vscode.window.visibleTextEditors) if (editor.document.uri.toString() === key) for (const type of this.types) editor.setDecorations(type, []);
  }
  /** The card for a hover on the first column of a line that has the gutter: where the gutter text is, VS Code asks for the hover at column 0. */
  private async hover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const state = this.shown.get(document.uri.toString());
    if (!state?.file || document.isDirty || position.character !== 0) return undefined;
    const block = blockAt(state.file.blocks, position.line); if (!block) return undefined;
    return new vscode.Hover(await this.card(state.repositoryId, block), new vscode.Range(position.line, 0, position.line, 0));
  }
  private async card(repositoryId: string, block: BlameBlock): Promise<vscode.MarkdownString> {
    const commit = block.commit, card = new vscode.MarkdownString();
    card.supportHtml = false; card.isTrusted = { enabledCommands: [...cardCommands] };
    if (commit.uncommitted) { card.appendMarkdown(`**Not committed yet**\n\n${block.length === 1 ? 'This line is' : `These ${block.length} lines are`} changed in your working tree.`); return card; }
    const date = new Date(commit.timestamp * 1000), day = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : 'unknown date';
    const link = (command: (typeof cardCommands)[number], label: string) => `[${label}](command:${command}?${encodeURIComponent(JSON.stringify([{ repositoryId, oid: commit.oid }]))})`;
    const remote = await this.links.web(repositoryId).then(web => web !== undefined, () => false);
    card.appendMarkdown(`**${escapeMarkdown(commit.author)}**, ${describeAge(commit.timestamp * 1000, this.now())} (${day})\n\n${escapeMarkdown(commit.summary || '(no subject)')}\n\n`);
    card.appendMarkdown(`\`${commit.oid.slice(0, 10)}\` · ${block.length} line${block.length === 1 ? '' : 's'} · ${[link('gitPro.blame.openCommit', 'Open Commit'), link('gitPro.blame.copyHash', 'Copy Hash'), ...(remote ? [link('gitPro.blame.openOnRemote', 'Open on Remote')] : [])].join(' · ')}`);
    return card;
  }
  /** The commit a link of a card names, if it is exactly one: a repository that is open and a full object ID. */
  private target(argument: unknown): BlameTarget {
    const value = Array.isArray(argument) ? argument[0] : argument;
    const { repositoryId, oid } = (value && typeof value === 'object' ? value : {}) as { repositoryId?: unknown; oid?: unknown };
    if (typeof repositoryId !== 'string' || typeof oid !== 'string' || !this.registry.list().some(repo => repo.id === repositoryId)) throw new Error('Use this from the blame card of a line.');
    return { repositoryId, oid: validateOid(oid) };
  }
  open(argument: unknown): void { const target = this.target(argument); this.openCommit(target.repositoryId, target.oid); }
  async copyHash(argument: unknown): Promise<void> { await vscode.env.clipboard.writeText(this.target(argument).oid); }
  async openOnRemote(argument: unknown): Promise<void> {
    const target = this.target(argument), url = await this.links.commit(target.repositoryId, target.oid);
    if (!url) throw new Error('This repository\'s remote is not on a host Git Pro knows. Name its host in gitPro.remoteHosts.');
    await vscode.env.openExternal(vscode.Uri.parse(url, true));
  }
  dispose(): void {
    this.disposed = true;
    for (const key of [...this.shown.keys()]) this.forget(key);
    for (const item of this.subscriptions) item.dispose();
    for (const type of this.types) type.dispose();
  }
}
