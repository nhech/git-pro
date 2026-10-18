import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { GitService } from '../../git/git.service';
import { parseCommitMessage } from '../protocol';
import { redact } from '../../security/redaction';
import { commitHtml } from './commit-html';
import { boundedInteger, conventionalHelp, conventionalTypes } from '../../utils/settings';
import { recoveryFor } from '../../utils/recovery';
import { silentLogger, type Logger } from '../../utils/logging';

export class CommitComposer implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private session = ''; private busy = false; private disposed = false;
  private readonly drafts = new Map<string, string>();
  private persistence: Promise<void> = Promise.resolve();
  private readonly subscription: { dispose(): void };
  private readonly configurationSubscription:vscode.Disposable;
  constructor(private readonly context: vscode.ExtensionContext, private readonly git: GitService,
    private readonly commit: (id: string, message: string, options: { amend: boolean; signoff: boolean; noVerify: boolean }, push: boolean) => Promise<boolean>,
    private readonly logger:Logger=silentLogger) {
    this.subscription = git.registry.onDidChange(() => { void this.update(); });
    this.configurationSubscription=vscode.workspace.onDidChangeConfiguration(event=>{if(event.affectsConfiguration('gitPro.commit'))void this.update();});
  }
  private key(id: string): string { return `gitPro.draft:${id}`; }
  private saveDraft(id: string, message: string): Promise<void> {
    this.drafts.set(id, message);
    this.persistence = this.persistence.catch(() => undefined).then(() => this.context.workspaceState.update(this.key(id), message));
    return this.persistence;
  }
  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view; this.session = randomUUID(); const session = this.session;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'commit.js'));
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'commit.css'));
    const icons = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'codicons', 'codicon.css'));
    const nonce = randomUUID().replace(/-/g, '');
    view.webview.html = commitHtml({ session, nonce, style: style.toString(), icons: icons.toString(), script: script.toString(), cspSource: view.webview.cspSource });
    const receive = view.webview.onDidReceiveMessage(async value => {
      try {
        const item = parseCommitMessage(value);
        if (this.disposed || item.session !== session || this.session !== session) throw new Error('Composer session expired.');
        if (item.type === 'ready') { await this.update(); return; }
        if (this.git.registry.active?.id !== item.repositoryId) throw new Error('Repository changed. Review the composer before committing.');
        if (item.type === 'clearHistory') {
          if (this.busy) throw new Error('Wait for the commit to finish before clearing history.');
          await this.clearHistory(); return;
        }
        if (item.type === 'draft') {
          if (this.busy) throw new Error('Wait for the commit to finish before editing.');
          await this.saveDraft(item.repositoryId, item.message); return;
        }
        if (this.busy) throw new Error('A commit is already in progress.');
        const committedRoot=this.git.repository(item.repositoryId).root;
        this.busy = true;
        try {
          await this.saveDraft(item.repositoryId, item.message); await this.update();
          const success = await this.commit(item.repositoryId, item.message, item, item.push);
          if (success) {
            const limit = boundedInteger(vscode.workspace.getConfiguration('gitPro',vscode.Uri.file(committedRoot)).get('commit.messageHistoryLimit'),20,0,100);
            const key = `gitPro.messages:${item.repositoryId}`;
            const messages = this.context.workspaceState.get<string[]>(key, []);
            await this.context.workspaceState.update(key, [item.message, ...messages.filter(message => message !== item.message)].slice(0, limit));
            if (this.drafts.get(item.repositoryId) === item.message) await this.saveDraft(item.repositoryId, '');
          }
        } finally { this.busy = false; await this.update(); }
      } catch (error) {
        if (this.session === session) {
          const recovery=recoveryFor(error);this.logger.error(recovery.diagnostic);
          await view.webview.postMessage({ type: 'error', session, message: recovery.message });
        }
      }
    });
    const disposed = view.onDidDispose(() => { if (this.view === view) { this.view = undefined; this.session = ''; } receive.dispose(); disposed.dispose(); });
    await this.update();
  }
  async update(): Promise<void> {
    const repo = this.git.registry.active;
    // A hidden view has no renderer; it sends `ready` and receives fresh state when shown again.
    if (!this.view || this.disposed || this.view.visible === false) return;
    if (!repo) {
      await this.view.webview.postMessage({ type: 'state', session: this.session, repositoryId: '', repository: 'Choose a repository', message: '', staged: 0, busy: false, operation: 'idle', subjectLimit: 72, history: [], branch: '', conventionalTypes: [] }); return;
    }
    const snapshot = this.git.registry.store.get(repo.id);
    const config=vscode.workspace.getConfiguration('gitPro',vscode.Uri.file(repo.root)),limit=boundedInteger(config.get('commit.subjectLimit'),72,20,200),historyLimit=boundedInteger(config.get('commit.messageHistoryLimit'),20,0,100);
    await this.view.webview.postMessage({ type: 'state', session: this.session, repositoryId: repo.id, repository: redact(repo.root),
      message: this.drafts.get(repo.id) ?? this.context.workspaceState.get(this.key(repo.id), ''),
      staged: (snapshot?.changes.filter(change => change.group === 'staged').length ?? 0) + (snapshot?.omitted?.filter(change => change.group === 'staged').length ?? 0), busy: this.busy,
      operation: snapshot?.operation ?? 'idle', subjectLimit: limit, conventionalTypes: conventionalTypes(config.get('commit.conventionalTypes')),
      history: this.context.workspaceState.get<string[]>(`gitPro.messages:${repo.id}`, []).slice(0,historyLimit),
      // The placeholder names the branch, as native Source Control does; detached HEAD shows none.
      branch: snapshot?.head && snapshot.head !== '(detached)' ? snapshot.head : '' });
  }
  /**
   * Conventional Commit…: a type, a scope and a ! are asked for in Quick Picks, which VS Code draws whole (the menu of the Commit view is clipped to the little room the view has), and the Commit view
   * writes `type(scope)!: ` at the start of the first line of its message. The view does the writing, so that it stays the one place that knows what the message says.
   */
  async chooseConventional(): Promise<void> {
    const repo = this.git.registry.active; if (!repo) throw new Error('Select a repository first.');
    if (this.busy) throw new Error('A commit is already in progress.');
    const types = conventionalTypes(vscode.workspace.getConfiguration('gitPro', vscode.Uri.file(repo.root)).get('commit.conventionalTypes'));
    if (!types.length) throw new Error('No commit types are listed in gitPro.commit.conventionalTypes.');
    const type = await vscode.window.showQuickPick([{ label: '$(close) No type', description: 'Remove the type from the first line', value: '' }, ...types.map(name => ({ label: name, description: conventionalHelp[name] ?? '', value: name }))],
      { title: 'Conventional Commit: type', placeHolder: 'The type of this change', matchOnDescription: true });
    if (!type) return;
    let scope = '', breaking = false;
    if (type.value) {
      const typed = await vscode.window.showInputBox({ title: 'Conventional Commit: scope', prompt: 'The part of the code this changes, if you want one. Press Enter to leave it out.', placeHolder: 'api', validateInput: value => /[()\r\n]/.test(value) ? 'A scope has no brackets.' : undefined });
      if (typed === undefined) return;
      scope = typed.trim();
      const shape = `${type.value}${scope ? `(${scope})` : ''}`;
      const kind = await vscode.window.showQuickPick([{ label: 'No', description: `${shape}: …`, value: false }, { label: 'Yes, a breaking change', description: `${shape}!: …`, value: true }], { title: 'Conventional Commit: breaking change?', placeHolder: 'A ! after the type says that users must change something' });
      if (!kind) return;
      breaking = kind.value;
    }
    const view = await this.shownView();
    if (this.git.registry.active?.id !== repo.id || this.busy) throw new Error('Repository changed. Choose the type again.');
    // The view's own state first, so that it knows the types when the choice arrives, even when it was only just shown.
    await this.update();
    await view.webview.postMessage({ type: 'conventional', session: this.session, repositoryId: repo.id, value: { type: type.value, scope, breaking } });
  }
  private async shownView(): Promise<vscode.WebviewView> {
    if (!this.view || this.view.visible === false) {
      await vscode.commands.executeCommand('gitPro.commitView.focus');
      for (let attempt = 0; attempt < 30 && (!this.view || this.view.visible === false); attempt++) await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
    if (!this.view || this.view.visible === false) throw new Error('The Commit view is not available.');
    return this.view;
  }
  async clearHistory(): Promise<void> {
    const repo = this.git.registry.active; if (!repo) return;
    await this.context.workspaceState.update(`gitPro.messages:${repo.id}`, []); await this.update();
  }
  dispose(): void { this.disposed = true; this.session = ''; this.subscription.dispose();this.configurationSubscription.dispose(); this.drafts.clear(); }
}
