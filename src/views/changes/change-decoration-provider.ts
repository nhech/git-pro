import * as vscode from 'vscode';
import { changeScheme, decorationFor, readChangeQuery } from './change-decorations';

/** Draws the status letter and colour of a Changes row from its URI (see change-decorations.ts). */
export class ChangeDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly registration = vscode.window.registerFileDecorationProvider(this);
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== changeScheme) return undefined;
    const change = readChangeQuery(uri.query); if (!change) return undefined;
    const { badge, color, label } = decorationFor(change.group, change.status);
    return { badge, color: new vscode.ThemeColor(color), tooltip: label, propagate: false };
  }
  dispose(): void { this.registration.dispose(); this.changed.dispose(); }
}
