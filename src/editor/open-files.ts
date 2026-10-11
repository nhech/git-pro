import * as vscode from 'vscode';
import * as path from 'node:path';
import { canonicalFilePath } from '../security/paths';
import { redact } from '../security/redaction';

/** TabInputTextMerge is proposed API. It exists at runtime in 1.100 and 1.141, so tabs are duck-typed on it and it is never imported or matched with instanceof (§3.14). */
export interface MergeTabInput { readonly base: vscode.Uri; readonly input1: vscode.Uri; readonly input2: vscode.Uri; readonly result: vscode.Uri }
export const isUri = (value: unknown): value is vscode.Uri => typeof value === 'object' && value !== null && typeof (value as { scheme?: unknown }).scheme === 'string' && typeof (value as { fsPath?: unknown }).fsPath === 'string';
export function mergeInput(tab: vscode.Tab | undefined): MergeTabInput | undefined {
  const input = tab?.input as Partial<MergeTabInput> | undefined;
  return input && typeof input === 'object' && isUri(input.base) && isUri(input.input1) && isUri(input.input2) && isUri(input.result) ? input as MergeTabInput : undefined;
}
/** Comparable absolute path: Windows paths are case-insensitive, and Uri.fsPath lowercases the drive letter while realpath does not. */
export function fileKey(file: string): string { const normal = path.normalize(file); return process.platform === 'win32' ? normal.toLowerCase() : normal; }
/**
 * fileKey of the canonical path. Authorized paths sit under realpath(root), while editors keep the path the workspace was opened with: a junction, symlink,
 * subst or mapped drive, or an 8.3 name. A path that cannot be resolved compares as it is.
 */
export async function canonicalKey(file: string): Promise<string> { try { return fileKey(await canonicalFilePath(file)); } catch { return fileKey(file); } }
export function allTabs(): vscode.Tab[] { return vscode.window.tabGroups.all.flatMap(group => group.tabs); }
/** The merge tab whose Result is this file, under whichever path either side was opened with. */
export async function mergeTabFor(file: string): Promise<vscode.Tab | undefined> {
  const lexical = fileKey(file); let canonical: string | undefined;
  for (const tab of allTabs()) {
    const input = mergeInput(tab); if (input?.result.scheme !== 'file') continue;
    if (fileKey(input.result.fsPath) === lexical || await canonicalKey(input.result.fsPath) === (canonical ??= await canonicalKey(file))) return tab;
  }
  return undefined;
}
/**
 * N12, shared by every action that reads or writes these files on disk (Accept, Mark Resolved, Apply & Next, the per-file quick pick, Get from Branch).
 * An unsaved editor on a target would later save its stale text over the result, and a merge editor writes its Result when it completes, so either refuses the
 * action before anything runs. Both sides compare in canonical form.
 */
export async function refuseUnsaved(files: readonly { readonly absolute: string; readonly path: string }[], options: { readonly mergeTabs?: boolean } = {}): Promise<void> {
  const dirty = vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file' && document.isDirty).map(document => document.uri);
  // Apply & Next stages right after Complete Merge, whose own tab may still be closing; it passes mergeTabs: false.
  const merging = options.mergeTabs === false ? [] : allTabs().flatMap(tab => { const input = mergeInput(tab); return input?.result.scheme === 'file' ? [input.result] : []; });
  if (!dirty.length && !merging.length) return;
  const targets = new Map<string, string>();
  for (const file of files) { targets.set(fileKey(file.absolute), file.path); targets.set(await canonicalKey(file.absolute), file.path); }
  const target = async (uri: vscode.Uri) => targets.get(fileKey(uri.fsPath)) ?? targets.get(await canonicalKey(uri.fsPath));
  for (const uri of dirty) { const file = await target(uri); if (file !== undefined) throw new Error(`Save or revert ${redact(file)} first.`); }
  for (const uri of merging) { const file = await target(uri); if (file !== undefined) throw new Error(`Close the merge editor for ${redact(file)} first.`); }
}
/** An open text document on this file under another path (an alias of the workspace): reusing its Uri keeps one model per file. */
export async function openDocumentUri(file: string): Promise<vscode.Uri | undefined> {
  const lexical = fileKey(file), canonical = await canonicalKey(file);
  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme !== 'file') continue;
    if (fileKey(document.uri.fsPath) === lexical) return document.uri;
    if (await canonicalKey(document.uri.fsPath) === canonical) return document.uri;
  }
  return undefined;
}
