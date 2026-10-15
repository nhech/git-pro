import * as vscode from 'vscode';

/**
 * Keeps a context key equal to the kind of item selected in a view (its `contextValue`, or empty for none or several), so a keyboard shortcut such as F2 or Delete can be
 * scoped to the items it acts on and the view's menu can show it. A shortcut runs without the item, so its command reads the view's selection too.
 */
export function trackSelection<T>(view: vscode.TreeView<T>, key: string, kindOf: (item: T) => string | undefined): vscode.Disposable {
  const set = () => { const items = view.selection; void vscode.commands.executeCommand('setContext', key, items.length === 1 ? kindOf(items[0]!) ?? '' : ''); };
  set();
  return view.onDidChangeSelection(set);
}
